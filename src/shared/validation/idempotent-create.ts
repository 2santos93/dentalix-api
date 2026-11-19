import { createHash } from 'node:crypto';
import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from './idempotency-key';

/**
 * DX-574: idempotencia de las altas clínicas que la web reintenta tras un
 * corte de red (evolución, anamnesis, plan, ítem del plan y receta). Mismo
 * contrato que los abonos (DX-109), los gastos (DX-274) y «Atender sin cita»
 * (DX-510):
 * - cabecera `Idempotency-Key` opcional, un UUID (400 si no lo es);
 * - la clave y la huella de la petición viven con la fila creada, con un
 *   único parcial por clínica `(tenantId, idempotencyKey)`;
 * - repetir la MISMA petición devuelve la fila original sin escribir nada
 *   (el controlador no vuelve a auditarla);
 * - la misma clave con otra petición es un 422 `IDEMPOTENCY_KEY_REUSED`.
 */

export const IDEMPOTENCY_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';

/** Descripción OpenAPI de la cabecera en las altas clínicas (DX-574). */
export const CLINICAL_IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'DX-574: UUID estable por intento de guardado (reintento tras un corte de red, doble clic). Repetir la MISMA petición con la misma clave devuelve el registro original sin crear otro ni volver a auditarlo; la misma clave con otros datos es 422 `IDEMPOTENCY_KEY_REUSED`. Por clínica; vive con el registro.',
} as const;

export const CLINICAL_IDEMPOTENCY_REUSED_DESCRIPTION =
  '`IDEMPOTENCY_KEY_REUSED`: la Idempotency-Key ya guardó otro registro con otros datos.';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdempotencyRequest {
  key: string;
  fingerprint: string;
}

/** Lo que el caso de uso le cuenta al controlador (para `req.skipAudit`). */
export interface IdempotencySignals {
  replayed?: boolean;
}

/** La fila que creó la clave, con la huella de su petición. */
export interface IdempotentRecord<T> {
  fingerprint: string | null;
  value: T;
}

/**
 * JSON canónico: claves ordenadas y sin `undefined` (un campo ausente y uno
 * `undefined` son la misma petición; el orden de las claves no cuenta).
 */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** SHA-256 (hex) del JSON canónico de `parts`. */
export function requestFingerprint(parts: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(parts)))
    .digest('hex');
}

/**
 * La clave de la cabecera con la huella de la petición, o `undefined` sin
 * cabecera (o vacía). 400 si no es un UUID. `parts` lleva una etiqueta del
 * recurso, los ids de la ruta y el cuerpo ya validado.
 */
export function idempotencyRequest(
  header: string | undefined,
  parts: unknown,
): IdempotencyRequest | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  if (!UUID_RE.test(raw)) {
    throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
  }
  return { key: raw.toLowerCase(), fingerprint: requestFingerprint(parts) };
}

function replay<T>(
  stored: IdempotentRecord<T>,
  request: IdempotencyRequest,
  reusedMessage: string,
  signals: IdempotencySignals | undefined,
): T {
  if (stored.fingerprint !== request.fingerprint) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: IDEMPOTENCY_KEY_REUSED_CODE,
      message: reusedMessage,
    });
  }
  if (signals) signals.replayed = true;
  return stored.value;
}

/**
 * Crea con idempotencia: sin clave, `create()` tal cual. Con clave, si ya hay
 * una fila suya la devuelve (o 422 si la petición era otra); si no, crea. Si
 * dos peticiones con la misma clave llegan a la vez, la segunda choca con el
 * único parcial dentro de la transacción del alta (que se deshace entera) y
 * devuelve la fila de la primera.
 */
export async function idempotentCreate<T>(
  request: IdempotencyRequest | undefined,
  ops: {
    find: (key: string) => Promise<IdempotentRecord<T> | null>;
    create: () => Promise<T>;
    reusedMessage: string;
    signals?: IdempotencySignals;
  },
): Promise<T> {
  if (!request) return ops.create();
  const stored = await ops.find(request.key);
  if (stored) return replay(stored, request, ops.reusedMessage, ops.signals);
  try {
    return await ops.create();
  } catch (error) {
    const raced = await ops.find(request.key);
    if (raced) return replay(raced, request, ops.reusedMessage, ops.signals);
    throw error;
  }
}
