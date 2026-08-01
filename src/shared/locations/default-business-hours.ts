import { Prisma } from '@prisma/client';

/**
 * Horario de atención con el que nace una sede nueva: lun–vie 9:00–13:00 y
 * 15:00–19:00, sáb 9:00–13:00, domingo cerrado (sin tramos).
 *
 * `weekday` sigue la convención de `Date.getDay()` (0=domingo .. 6=sábado), la
 * misma que usa el validador (`fitsBusinessHours`), para no convertir nada.
 *
 * Es un punto de partida editable, igual que `DEFAULT_DENTAL_CATALOG`: la clínica
 * lo ajusta en /settings/horarios. Deliberadamente NO se aplica a las sedes que
 * YA existen — sembrarles un horario las pasaría de "sin restricción" a
 * "restringidas" de golpe, rechazando citas que hoy son válidas.
 */
export const DEFAULT_BUSINESS_HOURS_TIMEZONE = 'America/Bogota';

const MORNING = { startMinute: 9 * 60, endMinute: 13 * 60 };
const AFTERNOON = { startMinute: 15 * 60, endMinute: 19 * 60 };

export const DEFAULT_BUSINESS_HOURS: {
  weekday: number;
  startMinute: number;
  endMinute: number;
}[] = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, ...MORNING },
    { weekday, ...AFTERNOON },
  ]),
  { weekday: 6, ...MORNING },
];

/**
 * Siembra el horario por defecto de una sede recién creada, DENTRO de la
 * transacción que la creó (así una sede no puede quedar a medio configurar).
 *
 * Idempotente por el unique `(tenantId, locationId)`: si la sede ya tuviera
 * horario, no se toca.
 */
export async function seedDefaultBusinessHours(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
): Promise<void> {
  const existing = await tx.locationSchedule.findFirst({
    where: { tenantId, locationId },
    select: { id: true },
  });
  if (existing) return;

  const schedule = await tx.locationSchedule.create({
    data: { tenantId, locationId, timezone: DEFAULT_BUSINESS_HOURS_TIMEZONE },
    select: { id: true },
  });
  await tx.locationScheduleRange.createMany({
    data: DEFAULT_BUSINESS_HOURS.map((r) => ({
      tenantId,
      scheduleId: schedule.id,
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
  });
}
