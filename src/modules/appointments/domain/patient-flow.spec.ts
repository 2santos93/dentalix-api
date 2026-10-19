import { AppointmentStatus, ClinicRole } from '@prisma/client';
import {
  IN_CLINIC_STATUSES,
  arrivalPunctuality,
  checkStatusTransition,
  isInClinic,
  minutesSince,
} from './patient-flow';

const { SCHEDULED, CONFIRMED, COMPLETED, CANCELLED, NO_SHOW } =
  AppointmentStatus;
const { ARRIVED, IN_CHAIR, READY_FOR_CHECKOUT } = AppointmentStatus;
const { RECEPTION, ASSISTANT, ADMIN, DENTIST } = ClinicRole;

function check(
  from: AppointmentStatus,
  to: AppointmentStatus,
  role: ClinicRole | null = ADMIN,
  isToday = true,
) {
  return checkStatusTransition({ from, to, role, isToday });
}

describe('patient-flow · máquina de transiciones (DX-200)', () => {
  it('los tres estados nuevos son «en clínica»; los demás no', () => {
    expect([...IN_CLINIC_STATUSES]).toEqual([
      ARRIVED,
      IN_CHAIR,
      READY_FOR_CHECKOUT,
    ]);
    expect(isInClinic(ARRIVED)).toBe(true);
    expect(isInClinic(NO_SHOW)).toBe(false);
    expect(isInClinic(COMPLETED)).toBe(false);
  });

  describe('camino feliz', () => {
    it.each([
      [SCHEDULED, ARRIVED, RECEPTION],
      [CONFIRMED, ARRIVED, ASSISTANT],
      [ARRIVED, IN_CHAIR, DENTIST],
      [ARRIVED, IN_CHAIR, ASSISTANT],
      [IN_CHAIR, READY_FOR_CHECKOUT, DENTIST],
      [READY_FOR_CHECKOUT, COMPLETED, RECEPTION],
      [IN_CHAIR, COMPLETED, ASSISTANT],
      [ARRIVED, CANCELLED, RECEPTION],
    ])('%s → %s (%s)', (from, to, role) => {
      expect(check(from, to, role)).toEqual({ ok: true });
    });

    it('ADMIN puede todo el flujo', () => {
      for (const [from, to] of [
        [SCHEDULED, ARRIVED],
        [ARRIVED, IN_CHAIR],
        [IN_CHAIR, READY_FOR_CHECKOUT],
        [READY_FOR_CHECKOUT, COMPLETED],
      ] as const) {
        expect(check(from, to, ADMIN)).toEqual({ ok: true });
      }
    });

    it('repetir el estado actual no es un cambio (sin error)', () => {
      expect(check(ARRIVED, ARRIVED, DENTIST)).toEqual({ ok: true });
    });
  });

  describe('permisos por rol (403)', () => {
    it.each([
      [SCHEDULED, ARRIVED, DENTIST],
      [ARRIVED, IN_CHAIR, RECEPTION],
      [IN_CHAIR, READY_FOR_CHECKOUT, RECEPTION],
      [READY_FOR_CHECKOUT, COMPLETED, DENTIST],
      [ARRIVED, CANCELLED, DENTIST],
    ])('%s → %s con %s', (from, to, role) => {
      const result = check(from, to, role);
      expect(result).toMatchObject({ ok: false, kind: 'FORBIDDEN' });
    });

    it('sin rol de clínica no hay flujo', () => {
      expect(check(SCHEDULED, ARRIVED, null)).toMatchObject({
        ok: false,
        kind: 'FORBIDDEN',
      });
    });
  });

  describe('saltos imposibles (409)', () => {
    it.each([
      [SCHEDULED, IN_CHAIR],
      [SCHEDULED, READY_FOR_CHECKOUT],
      [ARRIVED, READY_FOR_CHECKOUT],
      [COMPLETED, ARRIVED],
      [CANCELLED, ARRIVED],
      [NO_SHOW, ARRIVED],
      [READY_FOR_CHECKOUT, IN_CHAIR],
      [IN_CHAIR, ARRIVED],
      [ARRIVED, NO_SHOW],
      [IN_CHAIR, NO_SHOW],
      [IN_CHAIR, CANCELLED],
      [READY_FOR_CHECKOUT, CANCELLED],
      [ARRIVED, SCHEDULED],
      [IN_CHAIR, CONFIRMED],
    ])('%s → %s', (from, to) => {
      const result = check(from, to, ADMIN);
      expect(result).toMatchObject({ ok: false, kind: 'CONFLICT' });
    });

    it('volver de «Llegó» a agendada se hace con «Deshacer llegada»', () => {
      const result = check(ARRIVED, SCHEDULED);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(/Deshacer llegada/);
    });

    it('un paciente que llegó nunca es un no-show', () => {
      const result = check(ARRIVED, NO_SHOW);
      expect(!result.ok && result.message).toMatch(/llegó/);
    });

    it('la llegada solo se marca el día de la cita', () => {
      const result = check(SCHEDULED, ARRIVED, RECEPTION, false);
      expect(result).toMatchObject({ ok: false, kind: 'CONFLICT' });
      expect(!result.ok && result.message).toMatch(/día de la cita/);
    });
  });

  it('las transiciones de antes (sin flujo) no cambian', () => {
    for (const [from, to] of [
      [SCHEDULED, CONFIRMED],
      [SCHEDULED, COMPLETED],
      [CONFIRMED, NO_SHOW],
      [CANCELLED, SCHEDULED],
      [COMPLETED, SCHEDULED],
    ] as const) {
      expect(check(from, to, DENTIST)).toEqual({ ok: true });
    }
  });
});

describe('patient-flow · espera y puntualidad (DX-200)', () => {
  const start = new Date('2026-10-19T14:00:00.000Z'); // 09:00 en Bogotá

  it('verde si llegó antes (o justo a) la hora', () => {
    expect(
      arrivalPunctuality(start, new Date('2026-10-19T13:50:00.000Z')),
    ).toBe('ON_TIME');
    expect(arrivalPunctuality(start, start)).toBe('ON_TIME');
  });

  it('naranja hasta 5 minutos tarde, rojo después', () => {
    expect(
      arrivalPunctuality(start, new Date('2026-10-19T14:00:01.000Z')),
    ).toBe('LATE');
    expect(
      arrivalPunctuality(start, new Date('2026-10-19T14:05:00.000Z')),
    ).toBe('LATE');
    expect(
      arrivalPunctuality(start, new Date('2026-10-19T14:05:01.000Z')),
    ).toBe('VERY_LATE');
  });

  it('minutos enteros transcurridos, nunca negativos', () => {
    const arrived = new Date('2026-10-19T13:50:30.000Z');
    expect(minutesSince(arrived, new Date('2026-10-19T14:02:29.000Z'))).toBe(
      11,
    );
    expect(minutesSince(arrived, new Date('2026-10-19T13:49:00.000Z'))).toBe(0);
  });
});
