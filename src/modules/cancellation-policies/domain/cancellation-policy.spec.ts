import {
  CANCELLATION_POLICY_MESSAGES,
  computeCancellationNotice,
  policyInputError,
} from './cancellation-policy';

const HOUR = 3_600_000;
const start = new Date('2026-11-10T15:00:00.000Z');
const before = (ms: number) => new Date(start.getTime() - ms);

describe('computeCancellationNotice (DX-279)', () => {
  it('exactamente 24 h antes con una política de 24 h: NO es tardía', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(24 * HOUR),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 1440, lateCancellation: false });
  });

  it('un segundo menos de 24 h: 1439 minutos y tardía', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(24 * HOUR - 1000),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 1439, lateCancellation: true });
  });

  it('5 h antes con 24 h: 300 minutos, tardía (también por el enlace)', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(5 * HOUR),
        byKind: 'PATIENT_LINK',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 300, lateCancellation: true });
  });

  it('con la cita ya empezada: aviso 0 (nunca negativo) y tardía', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: new Date(start.getTime() + 20 * 60_000),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 0, lateCancellation: true });
  });

  it('con política de 0 h, cancelar con la cita empezada no es tardía', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: new Date(start.getTime() + HOUR),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 0,
      }),
    ).toEqual({ noticeMinutes: 0, lateCancellation: false });
  });

  it('una cancelación de la CLÍNICA nunca es tardía', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(HOUR),
        byKind: 'CLINIC',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 60, lateCancellation: false });
  });

  it('sin política en la sede nunca es tardía (los minutos sí se guardan)', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(HOUR),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: null,
      }),
    ).toEqual({ noticeMinutes: 60, lateCancellation: false });
  });

  it('cambio de hora: se cuenta el tiempo REAL en UTC, no el reloj de pared', () => {
    // Madrid pasa a verano el 29/03/2026 a las 02:00. De las 10:00 del 28 (UTC+1)
    // a las 10:00 del 29 (UTC+2) en el reloj de pared hay 24 h, pero solo 23
    // reales: con una política de 24 h es tardía.
    const appointment = new Date('2026-03-29T08:00:00.000Z'); // 10:00 Madrid
    const cancelled = new Date('2026-03-28T09:00:00.000Z'); // 10:00 Madrid
    expect(
      computeCancellationNotice({
        start: appointment,
        cancelledAt: cancelled,
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 1380, lateCancellation: true });
    // Y al volver al horario de invierno (25/10/2026), 24 h de pared son 25
    // reales: no es tardía.
    expect(
      computeCancellationNotice({
        start: new Date('2026-10-25T09:00:00.000Z'), // 10:00 Madrid (UTC+1)
        cancelledAt: new Date('2026-10-24T08:00:00.000Z'), // 10:00 Madrid (UTC+2)
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
      }),
    ).toEqual({ noticeMinutes: 1500, lateCancellation: false });
  });
});

describe('computeCancellationNotice · el paciente ya vino (M1)', () => {
  it('una cita en la clínica o completada nunca es tardía; el aviso se cuenta igual', () => {
    expect(
      computeCancellationNotice({
        start,
        cancelledAt: before(HOUR),
        byKind: 'STAFF_FOR_PATIENT',
        noticeHours: 24,
        attended: true,
      }),
    ).toEqual({ noticeMinutes: 60, lateCancellation: false });
  });
});

describe('policyInputError (DX-279)', () => {
  const ok = {
    noticeHours: 24,
    suggestedFee: null,
    currency: null,
    patientText: '',
  };

  it('acepta una política válida', () => {
    expect(policyInputError(ok)).toBeNull();
    expect(
      policyInputError({ ...ok, suggestedFee: 0, currency: 'COP' }),
    ).toBeNull();
    expect(policyInputError({ ...ok, noticeHours: 0 })).toBeNull();
    expect(policyInputError({ ...ok, noticeHours: 168 })).toBeNull();
    expect(
      policyInputError({ ...ok, patientText: 'a'.repeat(1000) }),
    ).toBeNull();
  });

  it.each([-1, 169, 1.5])('rechaza %p horas', (noticeHours) => {
    expect(policyInputError({ ...ok, noticeHours })).toBe(
      CANCELLATION_POLICY_MESSAGES.noticeHours,
    );
  });

  it('rechaza un importe negativo', () => {
    expect(policyInputError({ ...ok, suggestedFee: -1, currency: 'COP' })).toBe(
      CANCELLATION_POLICY_MESSAGES.fee,
    );
  });

  it('un importe exige su moneda y una moneda exige importe', () => {
    expect(policyInputError({ ...ok, suggestedFee: 10 })).toBe(
      CANCELLATION_POLICY_MESSAGES.currencyRequired,
    );
    expect(policyInputError({ ...ok, currency: 'COP' })).toBe(
      CANCELLATION_POLICY_MESSAGES.feeRequired,
    );
  });

  it('rechaza un texto de más de 1000 caracteres', () => {
    expect(policyInputError({ ...ok, patientText: 'a'.repeat(1001) })).toBe(
      CANCELLATION_POLICY_MESSAGES.patientText,
    );
  });
});
