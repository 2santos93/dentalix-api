import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../../../shared/time/civil-day';
import { BadRequestException, ConflictException } from '@nestjs/common';

export interface VisitAssignment {
  itemId: string;
  visit: number;
  visitLabel?: string | null;
}

export function validateVisits(
  status: string,
  items: VisitAssignment[],
  intervals: Record<string, number>,
): void {
  if (!['DRAFT', 'PRESENTED', 'ACCEPTED'].includes(status)) {
    throw new ConflictException(
      'El plan está cerrado: no se pueden cambiar sus visitas.',
    );
  }
  const ids = new Set<string>();
  const labels = new Map<number, string | null>();
  for (const item of items) {
    if (!Number.isInteger(item.visit) || item.visit < 1 || item.visit > 1000) {
      throw new BadRequestException(
        'La visita debe ser un entero entre 1 y 1000.',
      );
    }
    if (ids.has(item.itemId))
      throw new BadRequestException('Ítem repetido en las visitas.');
    ids.add(item.itemId);
    const label = item.visitLabel?.trim() || null;
    if (label && label.length > 60)
      throw new BadRequestException('La etiqueta admite hasta 60 caracteres.');
    if (labels.has(item.visit) && labels.get(item.visit) !== label) {
      throw new BadRequestException(
        'Los ítems de una visita deben tener la misma etiqueta.',
      );
    }
    labels.set(item.visit, label);
  }
  for (const [key, days] of Object.entries(intervals)) {
    if (
      !/^[1-9]\d{0,3}$/.test(key) ||
      Number(key) > 1000 ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > 3650
    ) {
      throw new BadRequestException(
        'El intervalo debe ser de 0 a 3650 días y pertenecer a una visita válida.',
      );
    }
  }
}

export function minimumVisitDate(
  previousCompleted: Date | null,
  intervalDays: number,
  now: Date,
  timeZone = 'UTC',
): Date {
  if (!previousCompleted || !intervalDays) return new Date(now);
  return new Date(
    Math.max(
      now.getTime(),
      zonedStartOfDay(
        addCivilDays(civilDateIn(previousCompleted, timeZone), intervalDays),
        timeZone,
      ).getTime(),
    ),
  );
}

export const RESERVED_APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'ARRIVED',
  'IN_CHAIR',
  'READY_FOR_CHECKOUT',
];

export function isUnscheduled(
  planStatus: string,
  itemStatus: string,
  appointments: { start: Date; status: string; deletedAt?: Date | null }[],
  now: Date,
): boolean {
  return (
    planStatus === 'ACCEPTED' &&
    itemStatus === 'ACCEPTED' &&
    !appointments.some(
      (a) =>
        !a.deletedAt &&
        RESERVED_APPOINTMENT_STATUSES.includes(a.status) &&
        (a.start >= now ||
          ['ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'].includes(a.status)),
    )
  );
}
