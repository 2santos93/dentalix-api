import { AppointmentStatus } from '@prisma/client';
import {
  PLAN_ITEMS_CANCELLED_MESSAGE,
  PLAN_ITEMS_CLOSED_MESSAGE,
  PLAN_ITEMS_NO_SHOW_MESSAGE,
  PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE,
  PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE,
  closedForPlanItems,
  heldInClinicMessage,
  heldInClinicToday,
  planItemsClosedMessage,
  reservationHolderView,
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

describe('DX-288 (revisión M1) titular en la clínica de «Traer a esta cita»', () => {
  const TZ = 'America/Bogota';
  // 23/10/2026 15:00 en Bogotá.
  const now = new Date('2026-10-23T20:00:00.000Z');

  it.each([
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_CHAIR,
    AppointmentStatus.READY_FOR_CHECKOUT,
  ])('en la clínica (%s) y de hoy en la zona de su sede: bloquea', (status) => {
    expect(
      heldInClinicToday(
        { status, start: new Date('2026-10-23T14:00:00.000Z') },
        TZ,
        now,
      ),
    ).toBe(true);
  });

  it('en la clínica pero de un día anterior (olvidada): no bloquea', () => {
    expect(
      heldInClinicToday(
        {
          status: AppointmentStatus.ARRIVED,
          start: new Date('2026-10-22T22:00:00.000Z'),
        },
        TZ,
        now,
      ),
    ).toBe(false);
  });

  it('el día civil es el de la zona de la sede, no el UTC', () => {
    // 24/10 01:00 UTC = 23/10 20:00 en Bogotá: hoy.
    expect(
      heldInClinicToday(
        {
          status: AppointmentStatus.IN_CHAIR,
          start: new Date('2026-10-24T01:00:00.000Z'),
        },
        TZ,
        now,
      ),
    ).toBe(true);
    // En Madrid, esa misma hora ya es el 24/10 y «ahora» el 23/10.
    expect(
      heldInClinicToday(
        {
          status: AppointmentStatus.IN_CHAIR,
          start: new Date('2026-10-23T22:30:00.000Z'),
        },
        'Europe/Madrid',
        now,
      ),
    ).toBe(false);
  });

  it.each([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED])(
    'agendada de hoy (%s): no bloquea',
    (status) => {
      expect(
        heldInClinicToday(
          { status, start: new Date('2026-10-23T21:00:00.000Z') },
          TZ,
          now,
        ),
      ).toBe(false);
    },
  );

  it('el 409 dice la hora y la sede de la cita titular (en su zona)', () => {
    expect(
      heldInClinicMessage({
        start: new Date('2026-10-23T14:05:00.000Z'),
        timeZone: TZ,
        locationName: 'Sede Norte',
      }),
    ).toBe(
      'Este tratamiento ya lo tiene otra cita con el paciente en la clínica, la de hoy a las 09:05 (Sede Norte). No se puede traer mientras esa cita siga en curso.',
    );
  });

  it('sin datos de la titular (sede no permitida, DX-089): el mensaje general', () => {
    expect(heldInClinicMessage(null)).toBe(
      PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE,
    );
    expect(PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE).not.toMatch(/\d/);
  });
});

describe('DX-293 aviso de reserva en otra cita: heldInClinic', () => {
  const TZ = 'America/Bogota';
  // 23/10/2026 15:00 en Bogotá.
  const now = new Date('2026-10-23T20:00:00.000Z');
  const holder = (status: AppointmentStatus, start: string) => ({
    appointmentId: 'b1',
    status,
    start: new Date(start),
    locationId: 'loc-norte',
    locationName: 'Sede Norte',
    locationLocale: 'en-US',
    locationHourCycle: 'h12' as const,
  });

  it.each([
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_CHAIR,
    AppointmentStatus.READY_FOR_CHECKOUT,
  ])(
    'titular de hoy en la clínica (%s), sede permitida: heldInClinic con su hora y sede',
    (status) => {
      expect(
        reservationHolderView(holder(status, '2026-10-23T14:05:00.000Z'), {
          timeZone: TZ,
          locationAllowed: true,
          now,
        }),
      ).toEqual({
        heldInClinic: true,
        appointmentId: 'b1',
        start: new Date('2026-10-23T14:05:00.000Z'),
        locationId: 'loc-norte',
        locationName: 'Sede Norte',
        timeZone: TZ,
        locale: 'en-US',
        hourCycle: 'h12',
      });
    },
  );

  it('es la misma regla que el 409 de «Traer a esta cita» (heldInClinicToday)', () => {
    const cases = [
      holder(AppointmentStatus.ARRIVED, '2026-10-23T14:05:00.000Z'),
      holder(AppointmentStatus.ARRIVED, '2026-10-22T22:00:00.000Z'),
      holder(AppointmentStatus.IN_CHAIR, '2026-10-24T01:00:00.000Z'),
      holder(AppointmentStatus.SCHEDULED, '2026-10-30T14:00:00.000Z'),
      holder(AppointmentStatus.CONFIRMED, '2026-10-23T21:00:00.000Z'),
    ];
    for (const h of cases)
      expect(
        reservationHolderView(h, { timeZone: TZ, locationAllowed: true, now })
          ?.heldInClinic,
      ).toBe(heldInClinicToday(h, TZ, now));
  });

  it('titular olvidada en la clínica de un día anterior: heldInClinic false («Traer» sigue)', () => {
    expect(
      reservationHolderView(
        holder(AppointmentStatus.ARRIVED, '2026-10-22T22:00:00.000Z'),
        { timeZone: TZ, locationAllowed: true, now },
      ),
    ).toMatchObject({ heldInClinic: false, appointmentId: 'b1' });
  });

  it('titular futura: heldInClinic false y el resto igual que antes', () => {
    expect(
      reservationHolderView(
        holder(AppointmentStatus.SCHEDULED, '2026-10-30T14:00:00.000Z'),
        { timeZone: TZ, locationAllowed: true, now },
      ),
    ).toEqual({
      heldInClinic: false,
      appointmentId: 'b1',
      start: new Date('2026-10-30T14:00:00.000Z'),
      locationId: 'loc-norte',
      locationName: 'Sede Norte',
      timeZone: TZ,
      locale: 'en-US',
      hourCycle: 'h12',
    });
  });

  it('el día es el de la zona de la sede de la titular', () => {
    // 23/10 22:30 UTC: en Madrid ya es el 24/10, «ahora» es el 23/10.
    expect(
      reservationHolderView(
        holder(AppointmentStatus.IN_CHAIR, '2026-10-23T22:30:00.000Z'),
        { timeZone: 'Europe/Madrid', locationAllowed: true, now },
      )?.heldInClinic,
    ).toBe(false);
  });

  it('sede permitida sin formato ni reloj: locale y hourCycle null en crudo, el resto igual (I4)', () => {
    expect(
      reservationHolderView(
        {
          ...holder(AppointmentStatus.SCHEDULED, '2026-10-30T14:00:00.000Z'),
          locationLocale: null,
          locationHourCycle: null,
        },
        { timeZone: TZ, locationAllowed: true, now },
      ),
    ).toEqual({
      heldInClinic: false,
      appointmentId: 'b1',
      start: new Date('2026-10-30T14:00:00.000Z'),
      locationId: 'loc-norte',
      locationName: 'Sede Norte',
      timeZone: TZ,
      locale: null,
      hourCycle: null,
    });
  });

  it('sede no permitida y titular de hoy en la clínica: heldInClinic sin cita, hora ni sede (DX-089)', () => {
    expect(
      reservationHolderView(
        holder(AppointmentStatus.IN_CHAIR, '2026-10-23T14:05:00.000Z'),
        { timeZone: TZ, locationAllowed: false, now },
      ),
    ).toEqual({
      heldInClinic: true,
      appointmentId: null,
      start: null,
      locationId: null,
      locationName: null,
      timeZone: null,
      locale: null,
      hourCycle: null,
    });
  });

  it.each([
    ['futura', AppointmentStatus.SCHEDULED, '2026-10-30T14:00:00.000Z'],
    [
      'olvidada de otro día',
      AppointmentStatus.ARRIVED,
      '2026-10-22T22:00:00.000Z',
    ],
  ])(
    'sede no permitida y titular %s: no se enseña (como en DX-273)',
    (_label, status, start) => {
      expect(
        reservationHolderView(holder(status, start), {
          timeZone: TZ,
          locationAllowed: false,
          now,
        }),
      ).toBeNull();
    },
  );
});
