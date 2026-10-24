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
import { memberNumberLast4 } from '../../patient-coverages/domain/member-number-rules';
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
  /**
   * DX-319: metadata que el handler añade al evento cuando solo él la conoce
   * (p. ej. el antes y después de un campo). Pasa por `sanitizeAuditMetadata`
   * como el resto y no pisa lo que pone el interceptor (campos, ruta, código).
   */
  auditMetadata?: Record<string, unknown>;
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

/** DX-107: hash, modo y totales del lote de importación de la respuesta. */
function importBatchOf(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    fileSha256?: unknown;
    duplicateMode?: unknown;
    totals?: Record<string, unknown>;
    progress?: Record<string, unknown>;
    undoneCreated?: unknown;
    undoneFilled?: unknown;
    balances?: {
      fileSha256?: unknown;
      totalRows?: unknown;
      errorRows?: unknown;
      validTotals?: unknown;
      progress?: Record<string, unknown>;
      addToExisting?: unknown;
      undoneCount?: unknown;
      undoneTotals?: unknown;
    } | null;
  };
  const sheet = b.balances ?? undefined;
  return {
    fileSha256: b.fileSha256,
    mode: b.duplicateMode,
    rows: b.totals?.totalRows,
    valid: b.totals?.validRows,
    duplicates: b.totals?.duplicateRows,
    errors: b.totals?.errorRows,
    created: b.progress?.createdCount,
    updated: b.progress?.updatedCount,
    undoneCreated: b.undoneCreated,
    undoneFilled: b.undoneFilled,
    // DX-262: la hoja de saldos y su total por moneda (lo que se importa).
    balanceFileSha256: sheet?.fileSha256,
    balanceRows: sheet?.totalRows,
    balanceErrors: sheet?.errorRows,
    balancesCreated: sheet?.progress?.created,
    balancesUndone: sheet?.undoneCount,
    balanceTotals: sheet?.validTotals,
    // Revisión M5: lo que retiró de verdad el deshacer.
    balanceUndoneTotals: sheet?.undoneTotals,
    // QA D1: si se pidió añadir a quien ya tenía saldo, y cuántos no se crearon.
    balanceAddToExisting: sheet?.addToExisting,
    balancesExisting: sheet?.progress?.existing,
  };
}

/** DX-300: códigos de los avisos de la receta emitida y si se confirmaron. */
function prescriptionSafetyOf(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    safetyRulesVersion?: unknown;
    safetyAlerts?: unknown;
    safetyOverrideReason?: unknown;
  };
  if (!Array.isArray(b.safetyAlerts)) return null;
  const codes = (severity: string) =>
    (b.safetyAlerts as unknown[]).flatMap((a) =>
      typeof a === 'object' &&
      a !== null &&
      'severity' in a &&
      a.severity === severity &&
      'code' in a
        ? [a.code]
        : [],
    );
  return {
    rulesVersion: b.safetyRulesVersion,
    blocking: codes('BLOCKING'),
    info: codes('INFO'),
    overridden:
      typeof b.safetyOverrideReason === 'string' &&
      b.safetyOverrideReason !== '',
  };
}

/**
 * DX-319: lo que el handler añade al evento. El antes/después del nº de
 * registro sanitario solo vale en un evento de sede (LOCATION).
 */
function handlerMetadata(
  options: AuditOptions,
  req: AuditedRequest,
): Record<string, unknown> {
  const { healthRegistration, ...rest } = req.auditMetadata ?? {};
  return options.resource === 'LOCATION'
    ? { ...rest, healthRegistration }
    : rest;
}

/** SEC-049: tipo de pagador, 4 últimos del nº y verificación de la cobertura. */
function coverageOf(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    payer?: { type?: unknown };
    memberNumber?: unknown;
    verifiedAt?: unknown;
  };
  return {
    payerType: b.payer?.type,
    memberNumberLast4:
      typeof b.memberNumber === 'string'
        ? memberNumberLast4(b.memberNumber)
        : null,
    verified: b.verifiedAt !== null && b.verifiedAt !== undefined,
  };
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
      ...handlerMetadata(options, req),
      ...(options.action === 'UPDATE'
        ? { changedFields: bodyFields(req.body) }
        : {}),
      params: req.params,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.statusChange ? { statusChange: options.statusChange } : {}),
      ...(options.search && resultCount !== null
        ? {
            search: {
              lot: req.query?.lot,
              reference: req.query?.reference,
              rows: resultCount,
            },
          }
        : {}),
      ...(options.importBatch
        ? { importBatch: importBatchOf(responseBody) }
        : {}),
      ...(options.prescriptionSafety
        ? { prescriptionSafety: prescriptionSafetyOf(responseBody) }
        : {}),
      ...(options.coverage ? { coverage: coverageOf(responseBody) } : {}),
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
