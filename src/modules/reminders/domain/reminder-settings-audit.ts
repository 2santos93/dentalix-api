import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';

export interface ReminderSettingsSnapshot {
  enabled: boolean;
  leadHours: number[];
  /** DX-469: alarma del calendario (sin fila, 24). */
  calendarAlarmHours: number;
}

/**
 * DX-360: ajustes de recordatorio de una sede (`PUT
 * /reminder-settings/:locationId`), en la sede de los ajustes. Sin fila aún,
 * el antes es el por defecto (desactivados, sin antelaciones). `null` si nada
 * cambió: no hay evento.
 */
export function reminderSettingsAuditEvent(
  ctx: AuditRequestContext,
  locationId: string,
  before: ReminderSettingsSnapshot,
  after: ReminderSettingsSnapshot,
): AuditEventDraft | null {
  return configAuditEvent(ctx, {
    action: 'UPDATE',
    resourceType: 'REMINDER_SETTINGS',
    resourceId: locationId,
    locationId,
    reason: 'REMINDER_SETTINGS_UPDATED',
    before: {
      enabled: before.enabled,
      leadHours: before.leadHours,
      calendarAlarmHours: before.calendarAlarmHours,
    },
    after: {
      enabled: after.enabled,
      leadHours: after.leadHours,
      calendarAlarmHours: after.calendarAlarmHours,
    },
  });
}
