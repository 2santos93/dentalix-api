import { ClinicRole } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import type {
  AuditActorRef,
  AuditEventDraft,
  AuditPatientRef,
} from '../domain/audit-event';
import { sanitizeAuditMetadata } from '../domain/audit-metadata';
import type { AuditOptions } from './audit-options';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que el interceptor lee de la petición (Express). */
export interface AuditedRequest {
  /** `req.ip` de Express: X-Forwarded-For solo con TRUST_PROXY (como DX-037). */
  ip?: string;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  user?: JwtPayload;
  tenantHost?: { host?: string; tenantId: string | null };
  /**
   * DX-259: el handler lo pone cuando la respuesta repite una escritura ya
   * auditada (p. ej. un `complete` idempotente que devuelve el documento ya
   * creado): no se registra otro evento.
   */
  skipAudit?: boolean;
}

/** Contexto de la petición capturado al entrar al handler. */
export interface AuditScope {
  tenantId: string;
  locationId: string | null;
  requestId: string | null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function responseId(
  body: unknown,
  field: 'id' | 'patientId' = 'id',
): string | null {
  return typeof body === 'object' && body !== null && field in body
    ? uuidOrNull((body as Record<string, unknown>)[field])
    : null;
}

function header(req: AuditedRequest, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function resourceIdOf(
  options: AuditOptions,
  req: AuditedRequest,
  body: unknown,
): string | null {
  const source = options.resourceId;
  if (!source) return null;
  return 'param' in source
    ? uuidOrNull(req.params?.[source.param])
    : responseId(body);
}

function patientOf(
  options: AuditOptions,
  req: AuditedRequest,
  body: unknown,
): AuditPatientRef | null {
  const source = options.patient;
  if (!source) return null;
  if ('response' in source) {
    const id = responseId(body, source.response);
    return id ? { kind: 'patient', id } : null;
  }
  const id = uuidOrNull(req.params?.[source.param]);
  if (!id) return null;
  return 'lookup' in source
    ? { kind: source.lookup, id }
    : { kind: 'patient', id };
}

/** Nombres (nunca valores) de los campos de primer nivel del cuerpo. */
function bodyFields(body: unknown): string[] {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? Object.keys(body)
    : [];
}

/**
 * Evento de una petición que terminó bien. La metadata lleva los parámetros de
 * la ruta y, en un UPDATE, los nombres de los campos enviados, saneada con
 * `sanitizeAuditMetadata`: un valor que no sea un id o un nombre de campo no
 * llega a la tabla. `null` sin sesión de clínica.
 */
export function buildAuditDraft(
  options: AuditOptions,
  req: AuditedRequest,
  responseBody: unknown,
  scope: AuditScope,
  resultCount: number | null = null,
): AuditEventDraft | null {
  if (!req.user || !isTenantPayload(req.user)) return null;
  return {
    tenantId: scope.tenantId,
    locationId: scope.locationId,
    actor: { kind: 'user', userId: req.user.sub, role: req.user.role },
    action: options.action,
    resourceType: options.resource,
    resourceId: resourceIdOf(options, req, responseBody),
    patient: patientOf(options, req, responseBody),
    requestId: scope.requestId,
    ip: req.ip ?? null,
    userAgent: header(req, 'user-agent'),
    metadata: sanitizeAuditMetadata({
      ...(options.action === 'UPDATE'
        ? { changedFields: bodyFields(req.body) }
        : {}),
      params: req.params,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.search && resultCount !== null
        ? {
            search: {
              lot: req.query?.lot,
              reference: req.query?.reference,
              rows: resultCount,
            },
          }
        : {}),
    }),
  };
}

const ROLES = new Set<string>(Object.values(ClinicRole));

/**
 * SEC-008: ¿la respuesta del login es un acceso break-glass? Lo dice la propia
 * API en el cuerpo (`breakGlass: true`), que también va firmado en el token.
 */
export function isBreakGlassLogin(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'breakGlass' in body &&
    body.breakGlass === true
  );
}

/**
 * Actor de un login correcto, del access token que la PROPIA API acaba de
 * firmar en esta petición (por eso basta decodificarlo). `null` si la
 * respuesta no trae uno legible.
 */
export function loginActor(body: unknown): AuditActorRef | null {
  const token =
    typeof body === 'object' && body !== null && 'accessToken' in body
      ? body.accessToken
      : null;
  if (typeof token !== 'string') return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub?: unknown; role?: unknown };
    const userId = uuidOrNull(payload.sub);
    if (
      !userId ||
      typeof payload.role !== 'string' ||
      !ROLES.has(payload.role)
    ) {
      return null;
    }
    return { kind: 'user', userId, role: payload.role as ClinicRole };
  } catch {
    return null;
  }
}
