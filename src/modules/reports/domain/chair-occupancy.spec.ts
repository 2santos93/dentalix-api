import {
  buildLocationOccupancy,
  holidayDaysIn,
  unionOf,
  type LocationOccupancyInput,
  type OccupancyAppointment,
} from './chair-occupancy';

// Fixture (DX-481): semana del lunes 2026-10-19 al domingo 2026-10-25 en
// America/Caracas (UTC−4 fijo). Horario de la sede lun–vie 9–13 y 15–19
// (480 min/día).
const CARACAS = 'America/Caracas';
const WEEK = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
  { weekday, startMinute: 15 * 60, endMinute: 19 * 60 },
]);
/** Hora de pared de Caracas como instante. */
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-04:00`);

let seq = 0;
function appt(
  chairId: string | null,
  day: string,
  from: string,
  to: string,
  status: string,
): OccupancyAppointment {
  seq += 1;
  return {
    id: `a${seq}`,
    chairId,
    start: at(day, from),
    end: at(day, to),
    status,
  };
}

const MON = '2026-10-19';
const TUE = '2026-10-20';
const WED = '2026-10-21';
const THU = '2026-10-22';

function fixture(): LocationOccupancyInput {
  return {
    from: MON,
    to: '2026-10-25',
    timeZone: CARACAS,
    ranges: WEEK,
    // Cierre de toda la sede el lunes 12:00–16:00: quita 12–13 y 15–16.
    closures: [{ start: at(MON, '12:00'), end: at(MON, '16:00') }],
    holidays: [
      // Puntual: el miércoles.
      { date: WED, recurring: false },
      // De cada año (el 23 de octubre, viernes en 2026).
      { date: '2019-10-23', recurring: true },
      // Fuera del período: no cuenta.
      { date: '2026-12-25', recurring: false },
    ],
    chairs: [
      { id: 's2', name: 'Sillón 2', active: true, sortOrder: 1 },
      { id: 's1', name: 'Sillón 1', active: true, sortOrder: 0 },
      { id: 's3', name: 'Sillón viejo', active: false, sortOrder: 2 },
      { id: 's4', name: 'Sillón prestado', active: false, sortOrder: 3 },
    ],
    appointments: [
      // Sillón 1
      appt('s1', MON, '09:00', '10:00', 'COMPLETED'), // 60 atendidos
      appt('s1', MON, '12:30', '13:30', 'SCHEDULED'), // en el cierre y fuera de horario: 0
      appt('s1', TUE, '10:00', '11:00', 'NO_SHOW'), // 60 reservados, no atendidos
      appt('s1', TUE, '11:00', '12:00', 'CANCELLED'), // no cuenta
      appt('s1', WED, '09:00', '10:00', 'COMPLETED'), // festivo: 0
      appt('s1', TUE, '18:30', '19:30', 'CONFIRMED'), // 30 (hasta las 19)
      // Sillón 2: dos citas que se pisan cuentan una vez.
      appt('s2', THU, '09:00', '13:00', 'COMPLETED'),
      appt('s2', THU, '10:00', '11:00', 'SCHEDULED'),
      // Sillón inactivo con una cita: sale.
      appt('s4', MON, '16:00', '16:30', 'COMPLETED'),
      // Sillón inactivo solo con una cancelada: no sale.
      appt('s3', THU, '15:00', '16:00', 'CANCELLED'),
      // Sin sillón: dos a la vez suman (son dos sillones).
      appt(null, THU, '09:00', '10:00', 'ARRIVED'),
      appt(null, THU, '09:00', '10:00', 'SCHEDULED'),
      appt(null, THU, '15:00', '15:45', 'NO_SHOW'),
    ],
  };
}

describe('holidayDaysIn (DX-481)', () => {
  it('puntuales en su fecha y recurrentes en su día y mes de cada año', () => {
    expect(
      holidayDaysIn('2026-10-19', '2027-10-23', [
        { date: '2026-10-21', recurring: false },
        { date: '2019-10-23', recurring: true },
      ]),
    ).toEqual(['2026-10-21', '2026-10-23', '2027-10-23']);
  });
});

describe('unionOf', () => {
  it('une los que se pisan o se tocan y descarta los vacíos', () => {
    expect(
      unionOf([
        { start: 5, end: 8 },
        { start: 0, end: 3 },
        { start: 3, end: 4 },
        { start: 6, end: 10 },
        { start: 12, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 10 },
    ]);
  });
});

describe('buildLocationOccupancy (DX-481)', () => {
  const r = buildLocationOccupancy(fixture());

  it('abiertos = horario − festivos − cierres de toda la sede', () => {
    // 5 × 480 − 2 festivos × 480 − 120 del cierre del lunes.
    expect(r.hasSchedule).toBe(true);
    expect(r.holidayDays).toBe(2);
    expect(r.openMinutesPerChair).toBe(5 * 480 - 2 * 480 - 120);
  });

  it('sillones activos en su orden y los inactivos solo con citas', () => {
    expect(r.chairs.map((c) => c.chairId)).toEqual(['s1', 's2', 's4']);
    expect(r.chairs[2]).toMatchObject({ active: false, attendedMinutes: 30 });
  });

  it('sillón 1: recorta a horario, quita festivos y canceladas; la inasistencia reserva pero no atiende', () => {
    expect(r.chairs[0]).toEqual({
      chairId: 's1',
      chairName: 'Sillón 1',
      active: true,
      openMinutes: 1320,
      reservedMinutes: 150,
      attendedMinutes: 60,
      noShowMinutes: 60,
      reservedAppointments: 5,
      attendedAppointments: 2,
      noShowAppointments: 1,
      reservedRate: Math.round((150 / 1320) * 10_000) / 10_000,
      attendedRate: Math.round((60 / 1320) * 10_000) / 10_000,
    });
  });

  it('sillón 2: dos citas que se pisan no cuentan dos veces', () => {
    expect(r.chairs[1]).toMatchObject({
      reservedMinutes: 240,
      attendedMinutes: 240,
      reservedAppointments: 2,
    });
  });

  it('«Sin sillón» suma cita a cita y no tiene porcentaje', () => {
    expect(r.noChair).toEqual({
      openMinutes: null,
      reservedMinutes: 165,
      attendedMinutes: 0,
      noShowMinutes: 45,
      reservedAppointments: 3,
      attendedAppointments: 0,
      noShowAppointments: 1,
      reservedRate: null,
      attendedRate: null,
    });
  });

  it('el total de la sede suma los sillones (sin «Sin sillón») sobre abiertos × sillones', () => {
    expect(r.totals).toEqual({
      openMinutes: 1320 * 3,
      reservedMinutes: 150 + 240 + 30,
      attendedMinutes: 60 + 240 + 30,
      noShowMinutes: 60,
      reservedAppointments: 8,
      attendedAppointments: 4,
      noShowAppointments: 1,
      reservedRate: Math.round((420 / 3960) * 10_000) / 10_000,
      attendedRate: Math.round((330 / 3960) * 10_000) / 10_000,
    });
  });

  it('sin horario: abiertos null, sin %, y las citas recortadas al período', () => {
    const noSchedule = buildLocationOccupancy({
      ...fixture(),
      from: MON,
      to: MON,
      ranges: [],
      closures: [],
      holidays: [],
      chairs: [{ id: 's1', name: 'Sillón 1', active: true, sortOrder: 0 }],
      appointments: [
        // Empieza el domingo 23:30: cuenta desde las 00:00 del lunes.
        {
          id: 'x',
          chairId: 's1',
          start: at('2026-10-18', '23:30'),
          end: at(MON, '00:30'),
          status: 'SCHEDULED',
        },
        // Del día siguiente: no toca el período.
        appt('s1', TUE, '09:00', '10:00', 'COMPLETED'),
      ],
    });
    expect(noSchedule.hasSchedule).toBe(false);
    expect(noSchedule.openMinutesPerChair).toBeNull();
    expect(noSchedule.noChair).toBeNull();
    expect(noSchedule.chairs[0]).toMatchObject({
      openMinutes: null,
      reservedMinutes: 30,
      reservedAppointments: 1,
      attendedAppointments: 0,
      reservedRate: null,
    });
    expect(noSchedule.totals.reservedRate).toBeNull();
  });

  it('el % nunca pasa de 1 (día de 25 h por el cambio de hora)', () => {
    // 2026-11-01 en Nueva York dura 25 h; el horario 0–24 h cuenta 1440 min
    // de pared y la cita, 1500 reales.
    const zone = 'America/New_York';
    const dst = buildLocationOccupancy({
      from: '2026-11-01',
      to: '2026-11-01',
      timeZone: zone,
      ranges: [{ weekday: 0, startMinute: 0, endMinute: 1440 }],
      closures: [],
      holidays: [],
      chairs: [{ id: 's1', name: 'Sillón 1', active: true, sortOrder: 0 }],
      appointments: [
        {
          id: 'y',
          chairId: 's1',
          start: new Date('2026-11-01T04:00:00Z'),
          end: new Date('2026-11-02T05:00:00Z'),
          status: 'COMPLETED',
        },
      ],
    });
    expect(dst.chairs[0].openMinutes).toBe(1440);
    expect(dst.chairs[0].reservedMinutes).toBe(1500);
    expect(dst.chairs[0].reservedRate).toBe(1);
    expect(dst.chairs[0].attendedRate).toBe(1);
  });

  it('una sede sin sillones: total con 0 abiertos y sin %', () => {
    const empty = buildLocationOccupancy({
      ...fixture(),
      chairs: [],
      appointments: [],
    });
    expect(empty.chairs).toEqual([]);
    expect(empty.totals).toMatchObject({
      openMinutes: 0,
      reservedRate: null,
    });
  });
});
