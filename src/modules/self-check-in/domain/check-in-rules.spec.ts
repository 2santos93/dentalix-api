import { AppointmentStatus } from '@prisma/client';
import {
  DEFAULT_CHECK_IN_SETTINGS,
  arrivalWindow,
  checkInResult,
  checkInSettingsError,
  isLateArrival,
  orderPending,
} from './check-in-rules';

// Caracas (UTC-4, sin horario de verano). Cita a las 10:00 locales = 14:00Z.
const ZONE = 'America/Caracas';
const START = new Date('2027-03-10T14:00:00.000Z');
const at = (iso: string) => new Date(iso);
const window = (
  now: Date,
  overrides: Partial<Parameters<typeof arrivalWindow>[0]> = {},
) =>
  arrivalWindow({
    start: START,
    status: AppointmentStatus.CONFIRMED,
    timeZone: ZONE,
    settings: DEFAULT_CHECK_IN_SETTINGS,
    now,
    ...overrides,
  });

describe('DX-265 · ventana de «Ya llegué» (reloj fijo)', () => {
  it('por defecto: de 30 min antes a 30 min después, bordes incluidos', () => {
    expect(window(at('2027-03-10T13:29:59.999Z')).state).toBe('TOO_EARLY');
    expect(window(at('2027-03-10T13:30:00.000Z')).state).toBe('AVAILABLE');
    expect(window(at('2027-03-10T14:30:00.000Z')).state).toBe('AVAILABLE');
    expect(window(at('2027-03-10T14:30:00.001Z')).state).toBe('TOO_LATE');
    expect(window(at('2027-03-10T14:00:00.000Z'))).toEqual({
      state: 'AVAILABLE',
      opensAt: at('2027-03-10T13:30:00.000Z'),
      closesAt: at('2027-03-10T14:30:00.000Z'),
    });
  });

  it('la ventana es la de la sede (X antes / Y después)', () => {
    const settings = {
      ...DEFAULT_CHECK_IN_SETTINGS,
      minutesBefore: 5,
      minutesAfter: 0,
    };
    expect(window(at('2027-03-10T13:54:00.000Z'), { settings }).state).toBe(
      'TOO_EARLY',
    );
    expect(window(at('2027-03-10T13:55:00.000Z'), { settings }).state).toBe(
      'AVAILABLE',
    );
    expect(window(at('2027-03-10T14:00:00.001Z'), { settings }).state).toBe(
      'TOO_LATE',
    );
  });

  it('solo el día de la cita en la zona de la sede (no el de UTC)', () => {
    // 23:50 de Caracas del 9 = 03:50Z del 10: otro día civil en la sede.
    const late = new Date('2027-03-10T03:50:00.000Z');
    expect(
      window(at('2027-03-10T03:40:00.000Z'), {
        start: late,
        settings: { ...DEFAULT_CHECK_IN_SETTINGS, minutesAfter: 60 },
      }).state,
    ).toBe('AVAILABLE');
    // A las 00:10 del día siguiente en la sede ya no.
    expect(
      window(at('2027-03-10T04:10:00.000Z'), {
        start: late,
        settings: { ...DEFAULT_CHECK_IN_SETTINGS, minutesAfter: 60 },
      }).state,
    ).toBe('UNAVAILABLE');
    // El día anterior, nada (ni «pronto»).
    expect(window(at('2027-03-09T14:00:00.000Z'))).toEqual({
      state: 'UNAVAILABLE',
      opensAt: null,
      closesAt: null,
    });
  });

  it('la ventana no empieza antes de la medianoche de la sede', () => {
    // Cita a las 00:10 en Caracas (04:10Z), 30 min antes sería el día anterior.
    const early = new Date('2027-03-10T04:10:00.000Z');
    const w = window(at('2027-03-10T04:05:00.000Z'), { start: early });
    expect(w.state).toBe('AVAILABLE');
    expect(w.opensAt).toEqual(new Date('2027-03-10T04:00:00.000Z'));
  });

  it('solo agendada o confirmada; ya en la clínica es ARRIVED; el resto, UNAVAILABLE', () => {
    const now = at('2027-03-10T14:00:00.000Z');
    expect(window(now, { status: AppointmentStatus.SCHEDULED }).state).toBe(
      'AVAILABLE',
    );
    for (const status of [
      AppointmentStatus.ARRIVED,
      AppointmentStatus.IN_CHAIR,
      AppointmentStatus.READY_FOR_CHECKOUT,
    ]) {
      expect(window(now, { status }).state).toBe('ARRIVED');
    }
    for (const status of [
      AppointmentStatus.CANCELLED,
      AppointmentStatus.NO_SHOW,
      AppointmentStatus.COMPLETED,
    ]) {
      expect(window(now, { status }).state).toBe('UNAVAILABLE');
    }
  });

  it('sin zona de la sede no se ofrece', () => {
    expect(
      window(at('2027-03-10T14:00:00.000Z'), { timeZone: null }).state,
    ).toBe('UNAVAILABLE');
  });
});

describe('DX-265 · triaje', () => {
  it('retraso: más tarde que el umbral (estricto)', () => {
    expect(isLateArrival(START, at('2027-03-10T14:10:00.000Z'), 10)).toBe(
      false,
    );
    expect(isLateArrival(START, at('2027-03-10T14:10:00.001Z'), 10)).toBe(true);
    expect(isLateArrival(START, at('2027-03-10T13:40:00.000Z'), 0)).toBe(false);
  });

  it('sin pendientes, «Tome asiento»; con alguno, «Pase por recepción»', () => {
    expect(checkInResult([])).toBe('TAKE_SEAT');
    for (const p of ['ANAMNESIS', 'CONSENT', 'PATIENT_DATA', 'LATE'] as const) {
      expect(checkInResult([p])).toBe('SEE_RECEPTION');
    }
  });

  it('orden canónico y sin repetir', () => {
    expect(orderPending(['LATE', 'ANAMNESIS', 'LATE', 'PATIENT_DATA'])).toEqual(
      ['ANAMNESIS', 'PATIENT_DATA', 'LATE'],
    );
  });
});

describe('DX-265 · ajustes', () => {
  it('minutos enteros de 0 a 240', () => {
    expect(checkInSettingsError({ minutesBefore: 0, lateMinutes: 240 })).toBe(
      null,
    );
    expect(checkInSettingsError({ minutesBefore: -1 })).not.toBeNull();
    expect(checkInSettingsError({ minutesAfter: 241 })).not.toBeNull();
    expect(checkInSettingsError({ lateMinutes: 1.5 })).not.toBeNull();
  });
});
