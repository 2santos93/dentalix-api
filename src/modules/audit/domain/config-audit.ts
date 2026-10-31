import type { AuditAction, AuditResourceType } from '@prisma/client';
import type { AuditEventDraft } from './audit-event';
import type { AuditConfigValue, AuditMetadata } from './audit-metadata';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from './audit-request-context';

/** Foto de los campos de configuración de un recurso, leída en la transacción. */
export type ConfigSnapshot = Readonly<Record<string, AuditConfigValue>>;

interface ConfigAuditBase {
  resourceType: AuditResourceType;
  resourceId: string;
  /** Código del evento, p. ej. `PAYER_UPDATED`. */
  reason: string;
  /**
   * Sede del recurso cuando es de una (horario, recordatorios, inventario).
   * Sin ella, la de la petición.
   */
  locationId?: string | null;
  /**
   * Campos de texto libre o largo (cuerpo, notas, motivo): cuentan para saber
   * si algo cambió y figuran en `changedFields`, pero su valor no se guarda.
   */
  hiddenFields?: readonly string[];
  /** Metadata propia del recurso (p. ej. `scheduleChange`). */
  extra?: AuditMetadata;
}

export type ConfigAuditSpec = ConfigAuditBase &
  (
    | { action: Extract<AuditAction, 'CREATE'>; after: ConfigSnapshot }
    | {
        action: Extract<AuditAction, 'UPDATE'>;
        before: ConfigSnapshot;
        after: ConfigSnapshot;
      }
    | { action: Extract<AuditAction, 'DELETE'>; before: ConfigSnapshot }
  );

function sameValue(a: AuditConfigValue, b: AuditConfigValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function visible(
  snapshot: ConfigSnapshot,
  fields: readonly string[],
  hidden: readonly string[],
): Record<string, AuditConfigValue> {
  return Object.fromEntries(
    fields
      .filter((f) => !hidden.includes(f) && f in snapshot)
      .map((f) => [f, snapshot[f]]),
  );
}

/**
 * DX-360: evento de un cambio de la configuración de la clínica, escrito por
 * el repositorio en la transacción del cambio (patrón de DX-359). Un alta
 * lleva el después; un retiro, el antes; una edición, solo los campos que de
 * verdad cambiaron. `null` si una edición no cambió nada: no hay evento.
 */
export function configAuditEvent(
  ctx: AuditRequestContext,
  spec: Exclude<ConfigAuditSpec, { action: 'UPDATE' }>,
): AuditEventDraft;
export function configAuditEvent(
  ctx: AuditRequestContext,
  spec: ConfigAuditSpec,
): AuditEventDraft | null;
export function configAuditEvent(
  ctx: AuditRequestContext,
  spec: ConfigAuditSpec,
): AuditEventDraft | null {
  const hidden = spec.hiddenFields ?? [];
  const metadata: AuditMetadata = { reason: spec.reason };
  if (spec.action === 'UPDATE') {
    const fields = [
      ...new Set([...Object.keys(spec.before), ...Object.keys(spec.after)]),
    ];
    const changed = fields
      .filter((f) => !sameValue(spec.before[f] ?? null, spec.after[f] ?? null))
      .sort();
    if (changed.length === 0) return null;
    metadata.changedFields = changed;
    const before = visible(spec.before, changed, hidden);
    const after = visible(spec.after, changed, hidden);
    if (Object.keys(before).length + Object.keys(after).length > 0) {
      metadata.configChange = { before, after };
    }
  } else {
    const side = spec.action === 'CREATE' ? spec.after : spec.before;
    const shown = visible(side, Object.keys(side), hidden);
    if (Object.keys(shown).length > 0) {
      metadata.configChange =
        spec.action === 'CREATE' ? { after: shown } : { before: shown };
    }
  }
  const draft = auditDraftFromContext(ctx, {
    action: spec.action,
    resourceType: spec.resourceType,
    resourceId: spec.resourceId,
    metadata: { ...metadata, ...spec.extra },
  });
  return spec.locationId !== undefined
    ? { ...draft, locationId: spec.locationId }
    : draft;
}
