import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
  {
    match: 'inventory_items_tenantId_name_key',
    message: 'Ya existe un ítem de inventario con ese nombre.',
  },
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
  {
    match: 'clinic_memberships',
    message: 'Esa persona ya pertenece a la clínica.',
  },
  {
    match: 'tenant_domains_host_key',
    message: 'Ese dominio ya está registrado.',
  },
  { match: 'host', message: 'Ese dominio ya está registrado.' },
];

export function conflictMessageForTarget(target: unknown): string {
  const key = Array.isArray(target) ? target.join(',') : String(target ?? '');
  const hit = CONFLICT_MESSAGES.find((m) => key.includes(m.match));
  return hit?.message ?? 'Ya existe un registro con esos datos.';
}

interface HttpishResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<HttpishResponse>();

    if (exception.code === 'P2002') {
      const status = HttpStatus.CONFLICT; // 409
      response.status(status).json({
        statusCode: status,
        error: 'Conflict',
        message: conflictMessageForTarget(exception.meta?.target),
      });
      return;
    }

    // Any other known Prisma error stays a 500, but is logged with its code so
    // it's diagnosable instead of an opaque stack.
    this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      statusCode: status,
      error: 'Internal Server Error',
      message: 'Ocurrió un error procesando la solicitud.',
    });
  }
}
