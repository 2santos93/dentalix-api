import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentRequestId } from '../observability/request-context';
import { stackWithoutMessage } from '../observability/safe-stack';

/**
 * Global filter that turns a Prisma **P2002 unique-constraint violation** into
 * a clean `409 Conflict` with a friendly Spanish message, instead of letting it
 * bubble up as a raw `500`. This is the app-wide safety net for the
 * "check-then-insert" race AND for create paths that rely on a DB unique index
 * without catching the violation themselves (patients docNumber, catalog code,
 * medical-history version, staff email, …). The frontend already surfaces
 * `ApiError.message` verbatim, so the user sees "Ya existe…" rather than a
 * generic error.
 *
 * `register-clinic.use-case` still maps its own P2002 inline (belt-and-
 * suspenders); this filter covers everything else uniformly.
 *
 * DX-042: también traduce las demás reglas de la base a respuestas genéricas,
 * sin el `DETAIL` de Postgres: CHECK (23514) y desbordamiento numérico (22003)
 * → 400; FK (P2003 / 23503) y los triggers de inmutabilidad (23001) → 409. Las violaciones de EXCLUDE (23P01) las
 * mapean los casos de uso de citas antes de llegar aquí.
 *
 * DX-431: una transacción que pasa de su tope o no consigue conexión a
 * tiempo (P2028 de tiempo) o cuya sesión cierra
 * `idle_in_transaction_session_timeout` (25P03) → 503 `TRANSACTION_TIMEOUT`;
 * una sentencia cancelada por `statement_timeout` (57014) → 503
 * `STATEMENT_TIMEOUT`. Los dos con `Retry-After` y el request id, nunca el
 * 500 genérico. Cualquier otro P2028 sigue siendo un 500.
 */

// Maps a Prisma unique-index name (or column list) in `meta.target` to a
// friendly message. Matched by substring so it works whether Prisma reports the
// constraint's `map:` name (e.g. "patients_tenant_doc_key") or the raw columns.
const CONFLICT_MESSAGES: { match: string; message: string }[] = [
  {
    match: 'patients_tenant_doc_key',
    message: 'Ya existe un paciente con ese número de documento.',
  },
  {
    match: 'docNumber',
    message: 'Ya existe un paciente con ese número de documento.',
  },
  {
    match: 'catalog_tenant_code_key',
    message: 'Ya existe un ítem del catálogo con ese código.',
  },
  // Índice de EXPRESIÓN (tenantId, locationId, lower(name)): Prisma informa
  // sus columnas, con la expresión tal cual.
  {
    match: 'inventory_items_tenant_location_name_key',
    message: 'Ya existe un insumo con ese nombre en esta sede.',
  },
  {
    match: 'lower(name)',
    message: 'Ya existe un insumo con ese nombre en esta sede.',
  },
  {
    match: 'tooth_records_source_plan_item_key',
    message: 'Ese procedimiento ya está registrado en el odontograma.',
  },
  {
    match: 'sourcePlanItemId',
    message: 'Ese procedimiento ya está registrado en el odontograma.',
  },
  // DX-120: dos anulaciones del mismo registro (la carrera la decide el
  // índice único parcial).
  {
    match: 'tooth_records_void_once_key',
    message: 'Este registro ya está anulado.',
  },
  { match: 'voidsRecordId', message: 'Este registro ya está anulado.' },
  {
    match: 'payments_tenant_idempotency_key',
    message: 'Este pago ya fue registrado.',
  },
  {
    match: 'users_email_key',
    message: 'Ese correo electrónico ya está registrado.',
  },
  { match: 'email', message: 'Ese correo electrónico ya está registrado.' },
  { match: 'tenants_subdomain_key', message: 'Ese subdominio ya está en uso.' },
  { match: 'subdomain', message: 'Ese subdominio ya está en uso.' },
  {
    match: 'mhv_tenant_patient_version_key',
    message:
      'La historia clínica cambió mientras editabas. Vuelve a cargarla y reintenta.',
  },
  // Dos ADMIN publicando la política a la vez calculan la misma versión
  // (DX-037). Por nombre de índice o por columnas (lo que traiga Prisma).
  {
    match: 'privacy_policy_versions_tenant_version_key',
    message:
      'Otra versión de la política se publicó a la vez. Recarga, revisa la vigente y reintenta.',
  },
  {
    match: 'tenantId,version',
    message:
      'Otra versión de la política se publicó a la vez. Recarga, revisa la vigente y reintenta.',
  },
  {
    match: 'clinic_memberships',
    message: 'Esa persona ya pertenece a la clínica.',
  },
  // SEC-009: el host solo es único entre los VERIFIED (de todas las
  // clínicas) y, dentro de una clínica, entre sus dominios vivos.
  {
    match: 'tenant_domains_verified_host_key',
    message: 'Otra cuenta ya verificó ese dominio.',
  },
  {
    match: 'tenant_domains_tenant_host_key',
    message: 'Ese dominio ya está registrado en tu clínica.',
  },
  { match: 'host', message: 'Ese dominio ya está registrado.' },
];

export function conflictMessageForTarget(target: unknown): string {
  // Prisma da `meta.target` como string[] (columnas) o string (índice).
  const key = Array.isArray(target)
    ? target.join(',')
    : typeof target === 'string'
      ? target
      : '';
  const hit = CONFLICT_MESSAGES.find((m) => key.includes(m.match));
  return hit?.message ?? 'Ya existe un registro con esos datos.';
}

interface HttpishResponse {
  status(code: number): { json(body: unknown): unknown };
  setHeader(name: string, value: string): unknown;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  /** Código de dominio estable para el cliente (p. ej. `TRANSACTION_TIMEOUT`). */
  code?: string;
  message: string;
  /** Solo en los 500 (DX-023): para encontrar la petición en el log. */
  requestId?: string;
}

// Respuestas GENÉRICAS para violaciones de reglas de la base (DX-042). Nunca
// llevan el mensaje de Postgres: su DETAIL incluye la fila entera ("Failing
// row contains (...)"), es decir, datos del paciente y nombres de tablas.
const CHECK_VIOLATION: ErrorBody = {
  statusCode: HttpStatus.BAD_REQUEST,
  error: 'Bad Request',
  message: 'Los datos enviados no cumplen las reglas de la clínica.',
};
const NUMERIC_OVERFLOW: ErrorBody = {
  statusCode: HttpStatus.BAD_REQUEST,
  error: 'Bad Request',
  message: 'Un importe o una cantidad supera el máximo permitido.',
};
const FK_VIOLATION: ErrorBody = {
  statusCode: HttpStatus.CONFLICT,
  error: 'Conflict',
  message:
    'La operación hace referencia a datos que no existen o que están en uso.',
};
// Un trigger de inmutabilidad (consentimiento o receta firmada, plan aceptado
// con firma — DX-012) rechazó el cambio. Los casos de uso responden 409 antes;
// esto es la red, sin el mensaje de Postgres.
const RESTRICT_VIOLATION: ErrorBody = {
  statusCode: HttpStatus.CONFLICT,
  error: 'Conflict',
  message: 'El registro está cerrado o firmado y ya no admite ese cambio.',
};
// DX-271: `dx271_completed_link_guard` rechazó retirar un ítem de una cita
// completada (ERRCODE propio Q0271). Los casos de uso responden 409 antes con
// el mismo texto (`PLAN_ITEMS_CLOSED_MESSAGE`); esto es la red.
const CLOSED_VISIT_ITEMS: ErrorBody = {
  statusCode: HttpStatus.CONFLICT,
  error: 'Conflict',
  message: 'Esta cita ya pasó: sus tratamientos no se cambian.',
};
// DX-393: las guardas de gastos y pagos de gasto (ERRCODE propios Q3930…Q3934)
// rechazaron una escritura que dejaría el gasto incoherente. El caso de uso
// responde antes con su propio 409/400 con el gasto bloqueado; esto es la red
// (p. ej. otra ruta o una réplica anterior que se adelantó). Mismo texto que
// el RAISE de la migración 20261105120000_dx393_expense_integrity.
const conflict = (message: string): ErrorBody => ({
  statusCode: HttpStatus.CONFLICT,
  error: 'Conflict',
  message,
});
export const EXPENSE_INTEGRITY_MESSAGES = {
  Q3930: 'El gasto está anulado: ya no admite pagos.',
  Q3931:
    'El pago supera lo pendiente del gasto. Recarga el gasto y vuelve a intentarlo.',
  Q3932:
    'El importe no puede ser menor a lo ya pagado. Recarga el gasto y vuelve a intentarlo.',
  Q3933:
    'El gasto tiene pagos sin anular: anúlalos antes de anular el gasto. Recarga el gasto y vuelve a intentarlo.',
  Q3934:
    'La anulación de la salida no coincide con su importe o con su caja. Vuelve a intentarlo.',
} as const;
// DX-427: `dx427_*_not_before_entry` rechazó una hora de anestesia, de un
// fármaco de sedación o de una toma anterior a la fecha de la evolución
// (ERRCODE propio Q4270). Mismo texto que el RAISE de la migración
// 20261107120000_dx427_anesthesia_sedation_checks.
export const CLINICAL_TIME_BEFORE_ENTRY_MESSAGE =
  'La hora no puede ser anterior a la fecha de la evolución.';
const CLINICAL_TIME_BEFORE_ENTRY: ErrorBody = {
  statusCode: HttpStatus.BAD_REQUEST,
  error: 'Bad Request',
  message: CLINICAL_TIME_BEFORE_ENTRY_MESSAGE,
};
// Dos transacciones se cruzaron (deadlock o fallo de serialización): Postgres
// abortó esta. Reintentar la operación la resuelve (DX-012).
const CONCURRENCY_CONFLICT: ErrorBody = {
  statusCode: HttpStatus.CONFLICT,
  error: 'Conflict',
  message:
    'Otra operación sobre los mismos datos se cruzó con esta. Vuelve a intentarlo.',
};
// DX-431 (OPS-012): cortes por tiempo. Son un estado previsto de carga, no un
// fallo del código: 503 con `Retry-After`, como el almacén o el semáforo de
// subidas (DX-259).
export const TIMEOUT_RETRY_AFTER_SECONDS = 5;
export const TRANSACTION_TIMEOUT_MESSAGE =
  'La operación tardó demasiado y se canceló sin guardar cambios. Vuelve a intentarlo en unos segundos.';
// La transacción interactiva pasó de TENANT_TX_TIMEOUT_MS, no consiguió
// conexión del pool en TENANT_TX_MAX_WAIT_MS (P2028), o Postgres cerró la
// sesión por idle_in_transaction_session_timeout (25P03): la transacción se
// deshizo entera, así que «sin guardar cambios» es cierto.
const TRANSACTION_TIMEOUT: ErrorBody = {
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'Service Unavailable',
  code: 'TRANSACTION_TIMEOUT',
  message: TRANSACTION_TIMEOUT_MESSAGE,
};
export const STATEMENT_TIMEOUT_MESSAGE =
  'La operación tardó demasiado y se canceló. Vuelve a intentarlo en unos segundos.';
// Postgres canceló UNA sentencia por el statement_timeout de dentalix_app
// (57014). Fuera de una transacción, lo hecho antes por otras sentencias ya
// quedó guardado: el mensaje no promete lo contrario.
const STATEMENT_TIMEOUT: ErrorBody = {
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'Service Unavailable',
  code: 'STATEMENT_TIMEOUT',
  message: STATEMENT_TIMEOUT_MESSAGE,
};
/**
 * Los P2028 de tiempo: transacción expirada (commit o consulta sobre ella) o
 * sin conexión para empezarla en `maxWait`. Otros P2028 («Transaction already
 * closed» por otro motivo) son fallos del código y siguen como 500.
 */
const P2028_TIMEOUT_PATTERN =
  /expired transaction|Unable to start a transaction in the given time|timeout for this transaction/i;

const INTERNAL_ERROR: ErrorBody = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  error: 'Internal Server Error',
  message: 'Ocurrió un error procesando la solicitud.',
};

/** SQLSTATE de Postgres → respuesta, para los que tienen una genérica. */
// SQLSTATE propios del repo: clase de implementación (primer carácter I–Z o
// 5–9). Las clases que empiezan por 0–4 o A–H las reserva el estándar SQL.
export const BY_SQLSTATE: Record<string, ErrorBody> = {
  '23514': CHECK_VIOLATION, // check_violation
  '22003': NUMERIC_OVERFLOW, // numeric_value_out_of_range
  '23503': FK_VIOLATION, // foreign_key_violation
  '23001': RESTRICT_VIOLATION, // restrict_violation (triggers de inmutabilidad)
  '40P01': CONCURRENCY_CONFLICT, // deadlock_detected
  '40001': CONCURRENCY_CONFLICT, // serialization_failure
  Q0271: CLOSED_VISIT_ITEMS, // propio (DX-271): vínculo de una cita completada
  // propios (DX-393): gasto anulado, tope, importe bajo lo pagado, anulación
  // con pagos vivos y OUTFLOW_VOID que no es el de su salida.
  Q3930: conflict(EXPENSE_INTEGRITY_MESSAGES.Q3930),
  Q3931: conflict(EXPENSE_INTEGRITY_MESSAGES.Q3931),
  Q3932: conflict(EXPENSE_INTEGRITY_MESSAGES.Q3932),
  Q3933: conflict(EXPENSE_INTEGRITY_MESSAGES.Q3933),
  Q3934: conflict(EXPENSE_INTEGRITY_MESSAGES.Q3934),
  Q4270: CLINICAL_TIME_BEFORE_ENTRY, // propio (DX-427): hora clínica anterior a la evolución
};

/**
 * SQLSTATE de un error de Prisma, si lo trae. Prisma 6 lo expone de dos formas:
 *  - ORM (`tx.x.create()`): `PrismaClientUnknownRequestError` sin `code` ni
 *    `meta`; el SQLSTATE solo aparece en `message` (`PostgresError { code: "23514", ...`).
 *  - raw (`$executeRaw`): `PrismaClientKnownRequestError` P2010 con `meta.code`.
 */
function sqlStateOf(
  exception:
    | Prisma.PrismaClientKnownRequestError
    | Prisma.PrismaClientUnknownRequestError,
): string | undefined {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = exception.meta as { code?: unknown } | undefined;
    return typeof meta?.code === 'string' ? meta.code : undefined;
  }
  return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(exception.message)?.[1];
}

/**
 * SQLSTATE (también de `P2003` → 23503 y `P2002` → 23505) de cualquier error, para los repositorios que
 * traducen una regla de la BD a su propio mensaje en español antes de que
 * llegue a este filtro. `undefined` si no es un error de Prisma con código.
 */
export function prismaRuleCode(error: unknown): string | undefined {
  // Los dos que Prisma traduce a su propio código (sin `meta.code`).
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2003') return '23503';
    if (error.code === 'P2002') return '23505';
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return sqlStateOf(error);
  }
  return undefined;
}

/**
 * Nombre de la constraint violada, solo para el log (nunca para la respuesta).
 * Es un identificador del esquema, no un dato: el resto del mensaje no se
 * registra porque el DETAIL de Postgres lleva la fila con datos clínicos.
 */
function constraintOf(
  exception:
    | Prisma.PrismaClientKnownRequestError
    | Prisma.PrismaClientUnknownRequestError,
): string {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = exception.meta as
      { constraint?: unknown; field_name?: unknown } | undefined;
    const name = meta?.constraint ?? meta?.field_name;
    if (typeof name === 'string') return name;
  }
  return (
    /constraint \\?"([A-Za-z0-9_]+)\\?"/.exec(exception.message)?.[1] ?? '-'
  );
}

/**
 * Mensaje de un error de Prisma apto para el log de un 500: conserva lo que
 * permite diagnosticarlo (p. ej. «Transaction already closed», «could not read
 * block»), pero quita el DETAIL de Postgres, que lleva la fila o la clave con
 * datos ("Failing row contains (...)", "Key (email)=(...)").
 */
export function redactedPrismaMessage(message: string): string {
  return message
    .replace(/detail: Some\("(?:[^"\\]|\\.)*"\)/g, 'detail: <oculto>')
    .replace(/DETAIL:[^`\n]*/g, 'DETAIL: <oculto>')
    .replace(/Failing row contains \([^\n]*\)/g, '<oculto>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

/**
 * Stack de un error de Prisma apto para el log (DX-023): la cabecera con el
 * mensaje ya redactado y solo los marcos `at ...`. El `stack` original repite
 * el mensaje crudo, con el DETAIL de Postgres, así que no se usa tal cual.
 */
export function redactedPrismaStack(error: Error): string {
  return stackWithoutMessage(
    error,
    `${error.name}: ${redactedPrismaMessage(error.message)}`,
  );
}

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception:
      | Prisma.PrismaClientKnownRequestError
      | Prisma.PrismaClientUnknownRequestError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<HttpishResponse>();
    const send = (body: ErrorBody): void => {
      response.status(body.statusCode).json(body);
    };

    const prismaCode =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? exception.code
        : undefined;

    if (prismaCode === 'P2002') {
      const knownError = exception as Prisma.PrismaClientKnownRequestError;
      send({
        statusCode: HttpStatus.CONFLICT, // 409
        error: 'Conflict',
        message: conflictMessageForTarget(knownError.meta?.target),
      });
      return;
    }

    const sqlState = sqlStateOf(exception);
    const timeout =
      prismaCode === 'P2028'
        ? P2028_TIMEOUT_PATTERN.test(exception.message)
          ? TRANSACTION_TIMEOUT
          : undefined
        : sqlState === '25P03'
          ? TRANSACTION_TIMEOUT
          : sqlState === '57014'
            ? STATEMENT_TIMEOUT
            : undefined;
    if (timeout) {
      // El mensaje dice qué tope fue (timeout, maxWait, idle o
      // statement_timeout); sin el DETAIL de Postgres.
      this.logger.warn(
        `Transacción o sentencia cortada por tiempo (${prismaCode === 'P2028' ? prismaCode : sqlState}), 503 ${timeout.code}: ${redactedPrismaMessage(exception.message)}`,
      );
      response.setHeader('Retry-After', String(TIMEOUT_RETRY_AFTER_SECONDS));
      const requestId = currentRequestId();
      send(requestId ? { ...timeout, requestId } : timeout);
      return;
    }

    const generic =
      prismaCode === 'P2003'
        ? FK_VIOLATION
        : prismaCode === 'P2034'
          ? CONCURRENCY_CONFLICT
          : sqlState
            ? BY_SQLSTATE[sqlState]
            : undefined;
    if (generic) {
      // Una regla de la base que la validación de la app no cubrió: se
      // registra para poder cerrarla también en la DTO o el caso de uso.
      this.logger.warn(
        `Regla de BD violada (${prismaCode ?? sqlState}): ${constraintOf(exception)}`,
      );
      send(generic);
      return;
    }

    // Cualquier otro error sigue siendo un 500, registrado con su código y su
    // mensaje para poder diagnosticarlo, pero sin el DETAIL (lleva datos).
    this.logger.error(
      `Prisma error ${prismaCode ?? sqlState ?? 'desconocido'}: ${redactedPrismaMessage(exception.message)}`,
      redactedPrismaStack(exception),
    );
    const requestId = currentRequestId();
    send(requestId ? { ...INTERNAL_ERROR, requestId } : INTERNAL_ERROR);
  }
}
