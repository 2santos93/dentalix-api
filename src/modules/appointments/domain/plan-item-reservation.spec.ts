import { AppointmentStatus } from '@prisma/client';
import {
  PLAN_ITEMS_CANCELLED_MESSAGE,
  PLAN_ITEMS_CLOSED_MESSAGE,
  PLAN_ITEMS_NO_SHOW_MESSAGE,
  PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE,
  closedForPlanItems,
  planItemsClosedMessage,
  reservedElsewhereMessage,
} from './plan-item-reservation';

describe('DX-271 reserva de ítems del plan', () => {
  const now = new Date('2026-10-23T14:20:00Z');
  const past = new Date('2026-10-23T14:00:00Z');
  const future = new Date('2026-10-30T14:00:00Z');

  it.each([
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ])('una cita %s está cerrada aunque sea futura', (status) => {
    expect(closedForPlanItems({ status, start: future }, now)).toBe(true);
  });

  it('una cita agendada o confirmada que ya empezó está cerrada; futura, no', () => {
    for (const status of [
      AppointmentStatus.SCHEDULED,
      AppointmentStatus.CONFIRMED,
    ]) {
      expect(closedForPlanItems({ status, start: past }, now)).toBe(true);
      expect(closedForPlanItems({ status, start: future }, now)).toBe(false);
    }
  });

  it('con el paciente en la clínica sigue abierta aunque ya empezó', () => {
    for (const status of [
      AppointmentStatus.ARRIVED,
      AppointmentStatus.IN_CHAIR,
      AppointmentStatus.READY_FOR_CHECKOUT,
    ])
      expect(closedForPlanItems({ status, start: past }, now)).toBe(false);
  });

  it('el mensaje de cierre es el del criterio', () => {
    expect(PLAN_ITEMS_CLOSED_MESSAGE).toBe(
      'Esta cita ya pasó: sus tratamientos no se cambian.',
    );
  });

  it('dice en qué cita está el ítem, con la fecha y la hora de la sede', () => {
    // 14:00 UTC = 9:00 en Bogotá y 15:00 en Madrid (CET desde el 25/10).
    expect(reservedElsewhereMessage(future, 'America/Bogota')).toBe(
      'Este tratamiento ya está reservado en otra cita, la del 30/10/2026 a las 09:00. Quítalo de esa cita o cancélala antes.',
    );
    expect(reservedElsewhereMessage(future, 'Europe/Madrid')).toContain(
      'la del 30/10/2026 a las 15:00',
    );
    // Sin cita conocida (se canceló a la vez), el mensaje general.
    expect(reservedElsewhereMessage(null, 'America/Bogota')).toBe(
      'Este tratamiento ya está reservado en otra cita. Quítalo de esa cita o cancélala antes.',
    );
    expect(reservedElsewhereMessage(future, 'America/Bogota')).not.toMatch(
      /agendarlo/,
    );
  });

  it('una cita futura cancelada o no-show no «ya pasó»: lo dice su estado (M6)', () => {
    expect(
      planItemsClosedMessage(
        { status: AppointmentStatus.CANCELLED, start: future },
        now,
      ),
    ).toBe('Esta cita está cancelada: sus tratamientos no se cambian.');
    expect(PLAN_ITEMS_CANCELLED_MESSAGE).not.toMatch(/ya pasó/);
    expect(
      planItemsClosedMessage(
        { status: AppointmentStatus.NO_SHOW, start: future },
        now,
      ),
    ).toBe(PLAN_ITEMS_NO_SHOW_MESSAGE);
    expect(PLAN_ITEMS_NO_SHOW_MESSAGE).not.toMatch(/ya pasó/);
  });

  it('completada, o cancelada/no-show/agendada ya pasadas: «ya pasó»', () => {
    for (const appointment of [
      { status: AppointmentStatus.COMPLETED, start: future },
      { status: AppointmentStatus.COMPLETED, start: past },
      { status: AppointmentStatus.CANCELLED, start: past },
      { status: AppointmentStatus.NO_SHOW, start: past },
      { status: AppointmentStatus.SCHEDULED, start: past },
    ])
      expect(planItemsClosedMessage(appointment, now)).toBe(
        PLAN_ITEMS_CLOSED_MESSAGE,
      );
  });

  it('una cita de otra sede no permitida no enseña fecha ni sede (M3)', () => {
    expect(PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE).toBe(
      'Este tratamiento ya está reservado en otra cita de otra sede. Pide en esa sede que lo quiten de esa cita o la cancelen.',
    );
    expect(PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE).not.toMatch(/\d/);
  });
});
