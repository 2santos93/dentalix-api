import type { Prisma } from '@prisma/client';
import { localizedTextMapFromJson } from '../../../shared/i18n/localized-text';
import type { AppointmentTypeSummary } from '../domain/entities/appointment-type.entity';

/**
 * Lo que una cita (o una entrada de la lista de espera) lee de su tipo. DX-564:
 * también el mapa de indicaciones, solo para saber si tiene alguna; Prisma
 * trae la relación en una consulta aparte por id distinto, así que el mapa se
 * lee una vez por tipo y no por cita.
 */
export const APPOINTMENT_TYPE_SUMMARY_SELECT = {
  id: true,
  name: true,
  durationMinutes: true,
  color: true,
  preVisitInstructions: true,
} as const satisfies Prisma.AppointmentTypeSelect;

export type AppointmentTypeSummaryRow = Prisma.AppointmentTypeGetPayload<{
  select: typeof APPOINTMENT_TYPE_SUMMARY_SELECT;
}>;

export function toAppointmentTypeSummary(
  row: AppointmentTypeSummaryRow,
): AppointmentTypeSummary;
export function toAppointmentTypeSummary(
  row: AppointmentTypeSummaryRow | null | undefined,
): AppointmentTypeSummary | null;
export function toAppointmentTypeSummary(
  row: AppointmentTypeSummaryRow | null | undefined,
): AppointmentTypeSummary | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.durationMinutes,
    color: row.color,
    hasPreVisitInstructions:
      Object.keys(localizedTextMapFromJson(row.preVisitInstructions)).length >
      0,
  };
}
