import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditScheduleEntry } from '../../audit/domain/audit-metadata';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';
import type { ScheduleRange } from '../application/business-hours';

function entries(
  locationId: string,
  ranges: readonly ScheduleRange[],
): AuditScheduleEntry[] {
  return [...ranges]
    .sort(
      (a, b) =>
        a.weekday - b.weekday ||
        a.startMinute - b.startMinute ||
        a.endMinute - b.endMinute,
    )
    .map((r) => ({
      locationId,
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    }));
}

/**
 * DX-360: horario de atención de una sede reemplazado (`PUT
 * /locations/schedule`). Los tramos antes y después (días y minutos, como el
 * horario de un profesional en DX-233), en la sede del horario. `null` si la
 * semana queda igual: no hay evento.
 */
export function locationScheduleAuditEvent(
  ctx: AuditRequestContext,
  locationId: string,
  before: readonly ScheduleRange[],
  after: readonly ScheduleRange[],
): AuditEventDraft | null {
  const from = entries(locationId, before);
  const to = entries(locationId, after);
  if (JSON.stringify(from) === JSON.stringify(to)) return null;
  return {
    ...auditDraftFromContext(ctx, {
      action: 'UPDATE',
      resourceType: 'LOCATION_SCHEDULE',
      resourceId: locationId,
      metadata: {
        reason: 'LOCATION_SCHEDULE_REPLACED',
        scheduleChange: { before: from, after: to },
      },
    }),
    locationId,
  };
}
