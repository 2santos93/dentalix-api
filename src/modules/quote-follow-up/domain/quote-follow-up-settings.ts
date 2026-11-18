import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';

/**
 * Ajustes del seguimiento automático de presupuestos de una sede (DX-561, D1).
 * Mismos límites que los CHECK de `location_quote_follow_up_settings`; los
 * mensajes son los que ve el ADMIN.
 */
export const MAX_FOLLOW_UP_STEPS = 3;
export const MIN_OFFSET_DAYS = 1;
export const MAX_OFFSET_DAYS = 90;
export const MIN_FROM_HOUR = 0;
export const MAX_FROM_HOUR = 23;
export const MIN_UNTIL_HOUR = 1;
export const MAX_UNTIL_HOUR = 24;

/** Lo que propone la web al activar una sede sin ajustes (y lo que devuelve sin fila). */
export const DEFAULT_OFFSETS_DAYS: readonly number[] = [3, 10, 21];
export const DEFAULT_SEND_FROM_HOUR = 9;
export const DEFAULT_SEND_UNTIL_HOUR = 19;

export const OFFSETS_COUNT_MESSAGE = `Elige de 1 a ${MAX_FOLLOW_UP_STEPS} avisos.`;
export const OFFSET_RANGE_MESSAGE = `Cada aviso sale de ${MIN_OFFSET_DAYS} a ${MAX_OFFSET_DAYS} días después de presentar el presupuesto.`;
export const OFFSETS_ORDER_MESSAGE =
  'Los días de los avisos van de menor a mayor y sin repetirse (por ejemplo, 3, 10 y 21).';
export const FROM_HOUR_MESSAGE = `La franja empieza a una hora entera de ${MIN_FROM_HOUR} a ${MAX_FROM_HOUR}.`;
export const UNTIL_HOUR_MESSAGE = `La franja termina a una hora entera de ${MIN_UNTIL_HOUR} a ${MAX_UNTIL_HOUR}.`;
export const WINDOW_ORDER_MESSAGE =
  'La franja horaria debe terminar después de empezar (por ejemplo, de 9 a 19).';

export interface QuoteFollowUpSettingsInput {
  enabled: boolean;
  offsetsDays: number[];
  sendFromHour: number;
  sendUntilHour: number;
}

/** Lo que se guarda y se audita (el antes sin fila es el por defecto, apagado). */
export interface QuoteFollowUpSettingsSnapshot {
  enabled: boolean;
  offsetsDays: number[];
  sendFromHour: number;
  sendUntilHour: number;
}

export const DEFAULT_SETTINGS: QuoteFollowUpSettingsSnapshot = {
  enabled: false,
  offsetsDays: [...DEFAULT_OFFSETS_DAYS],
  sendFromHour: DEFAULT_SEND_FROM_HOUR,
  sendUntilHour: DEFAULT_SEND_UNTIL_HOUR,
};

const isInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n);

/** El primer problema de unos ajustes, en español; `null` si valen. */
export function quoteFollowUpSettingsError(
  input: QuoteFollowUpSettingsInput,
): string | null {
  const offsets = input.offsetsDays;
  if (
    !Array.isArray(offsets) ||
    offsets.length < 1 ||
    offsets.length > MAX_FOLLOW_UP_STEPS
  ) {
    return OFFSETS_COUNT_MESSAGE;
  }
  if (
    offsets.some((d) => !isInt(d) || d < MIN_OFFSET_DAYS || d > MAX_OFFSET_DAYS)
  ) {
    return OFFSET_RANGE_MESSAGE;
  }
  if (offsets.some((d, i) => i > 0 && d <= offsets[i - 1])) {
    return OFFSETS_ORDER_MESSAGE;
  }
  if (
    !isInt(input.sendFromHour) ||
    input.sendFromHour < MIN_FROM_HOUR ||
    input.sendFromHour > MAX_FROM_HOUR
  ) {
    return FROM_HOUR_MESSAGE;
  }
  if (
    !isInt(input.sendUntilHour) ||
    input.sendUntilHour < MIN_UNTIL_HOUR ||
    input.sendUntilHour > MAX_UNTIL_HOUR
  ) {
    return UNTIL_HOUR_MESSAGE;
  }
  if (input.sendUntilHour <= input.sendFromHour) return WINDOW_ORDER_MESSAGE;
  return null;
}

/**
 * Auditoría de `PUT /quote-follow-up-settings/:locationId`: UPDATE de
 * CLINIC_SETTINGS (el recurso de Ajustes › Presupuestos, como la validez de
 * DX-379) con el antes y el después, `resourceId` = la sede y en la sede de
 * los ajustes (patrón de DX-360). `null` si nada cambió: no hay evento.
 */
export function quoteFollowUpSettingsAuditEvent(
  ctx: AuditRequestContext,
  locationId: string,
  before: QuoteFollowUpSettingsSnapshot,
  after: QuoteFollowUpSettingsSnapshot,
): AuditEventDraft | null {
  const snap = (s: QuoteFollowUpSettingsSnapshot) => ({
    enabled: s.enabled,
    offsetsDays: [...s.offsetsDays],
    sendFromHour: s.sendFromHour,
    sendUntilHour: s.sendUntilHour,
  });
  return configAuditEvent(ctx, {
    action: 'UPDATE',
    resourceType: 'CLINIC_SETTINGS',
    resourceId: locationId,
    locationId,
    reason: QUOTE_FOLLOW_UP_SETTINGS_REASON,
    before: snap(before),
    after: snap(after),
  });
}

export const QUOTE_FOLLOW_UP_SETTINGS_REASON =
  'QUOTE_FOLLOW_UP_SETTINGS_UPDATED';
