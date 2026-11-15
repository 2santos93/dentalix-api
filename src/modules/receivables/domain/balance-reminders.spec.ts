import {
  DEFAULT_BALANCE_REMINDER_POLICY,
  decideReminder,
  policyError,
  reminderStage,
  type BalanceReminderPolicy,
} from './balance-reminders';

const POLICY: BalanceReminderPolicy = { ...DEFAULT_BALANCE_REMINDER_POLICY };
const TODAY = '2026-11-15';

function decide(
  oldestAgeDays: number | null,
  noticeDays: string[] = [],
  policy: BalanceReminderPolicy = POLICY,
  today = TODAY,
) {
  return decideReminder(policy, { today, oldestAgeDays, noticeDays });
}

describe('reminderStage (DX-146)', () => {
  it.each([
    [0, 0],
    [6, 0],
    [7, 1],
    [29, 1],
    [30, 2],
    [59, 2],
    [60, 3],
    [400, 3],
  ])('con %i días está en el tramo %i (7/30/60)', (age, stage) => {
    expect(reminderStage([7, 30, 60], age)).toBe(stage);
  });
});

describe('decideReminder (DX-146)', () => {
  it('sin nada vencido, o antes del primer tramo, no toca avisar', () => {
    expect(decide(null).due).toBe(false);
    expect(decide(0).due).toBe(false);
    const six = decide(6);
    expect(six).toMatchObject({ due: false, stage: 0, stageDays: null });
    expect(six.debtSince).toBe('2026-11-09');
  });

  it('el día en que la cuota cumple 7 días vencida toca el primer aviso', () => {
    expect(decide(7)).toEqual({
      due: true,
      stage: 1,
      stageDays: 7,
      noticesSent: 0,
      lastNoticeOn: null,
      debtSince: '2026-11-08',
    });
  });

  it('avisado hoy sale de la lista hasta el tramo siguiente', () => {
    expect(decide(7, [TODAY])).toMatchObject({
      due: false,
      noticesSent: 1,
      lastNoticeOn: TODAY,
    });
    // Mañana sigue en el tramo 1, ya avisado.
    expect(decide(8, ['2026-11-14'])).toMatchObject({ due: false, stage: 1 });
    // Al llegar a 30 días: segundo aviso.
    expect(decide(30, ['2026-10-23'])).toMatchObject({
      due: true,
      stage: 2,
      noticesSent: 1,
    });
  });

  it('quien llega tarde a un tramo recibe UN aviso, no los de los tramos anteriores', () => {
    expect(decide(65)).toMatchObject({ due: true, stage: 3 });
    expect(decide(66, ['2026-11-14'])).toMatchObject({ due: false, stage: 3 });
    expect(decide(120, ['2026-11-14'], POLICY, '2027-01-08')).toMatchObject({
      due: false,
    });
  });

  it('respeta el mínimo de días entre avisos aunque cambie de tramo', () => {
    // Avisado a los 25 días (tramo 1, tarde); a los 30 solo han pasado 5.
    const notice = '2026-11-10';
    expect(decide(30, [notice])).toMatchObject({ due: false, stage: 2 });
    expect(decide(31, [notice], POLICY, '2026-11-16')).toMatchObject({
      due: false,
    });
    expect(decide(32, [notice], POLICY, '2026-11-17')).toMatchObject({
      due: true,
      stage: 2,
    });
  });

  it('nunca más de maxNotices por deuda, aunque la clínica añada tramos', () => {
    const notices = ['2026-09-01', '2026-09-20', '2026-10-10'];
    // Deuda desde el 2026-08-20; 87 días hoy.
    expect(decide(87, notices)).toMatchObject({
      due: false,
      noticesSent: 3,
    });
    const morePolicy = { days: [7, 30, 80], maxNotices: 3, minGapDays: 7 };
    expect(decide(87, notices, morePolicy)).toMatchObject({ due: false });
    const higherCap = { ...morePolicy, maxNotices: 4 };
    expect(decide(87, notices, higherCap)).toMatchObject({
      due: true,
      stage: 3,
    });
  });

  it('los avisos de una deuda anterior (ya saldada) no cuentan para la nueva', () => {
    // Avisos de agosto; la deuda nueva venció el 2026-11-05 (10 días).
    const old = ['2026-08-01', '2026-08-20', '2026-09-10'];
    expect(decide(10, old)).toMatchObject({
      due: true,
      stage: 1,
      noticesSent: 0,
      lastNoticeOn: null,
      debtSince: '2026-11-05',
    });
  });

  it('un aviso con fecha posterior a hoy (reloj desajustado) no cuenta', () => {
    expect(decide(7, ['2026-11-16'])).toMatchObject({
      due: true,
      noticesSent: 0,
    });
  });

  it('un solo tramo con separación de 1 día', () => {
    const policy = { days: [1], maxNotices: 1, minGapDays: 1 };
    expect(decide(1, [], policy).due).toBe(true);
    expect(decide(2, ['2026-11-14'], policy).due).toBe(false);
  });
});

describe('policyError (DX-146)', () => {
  it('acepta la política por defecto', () => {
    expect(policyError(POLICY)).toBeNull();
  });

  it.each([
    [{ ...POLICY, days: [] }, 'Indica de 1 a 3 tramos de días.'],
    [{ ...POLICY, days: [7, 30, 60, 90] }, 'Indica de 1 a 3 tramos de días.'],
    [
      { ...POLICY, days: [0, 30] },
      'Cada tramo es un número entero de días entre 1 y 365.',
    ],
    [
      { ...POLICY, days: [7, 366] },
      'Cada tramo es un número entero de días entre 1 y 365.',
    ],
    [
      { ...POLICY, days: [7.5] },
      'Cada tramo es un número entero de días entre 1 y 365.',
    ],
    [
      { ...POLICY, days: [30, 7] },
      'Los tramos van de menor a mayor, sin repetir días.',
    ],
    [
      { ...POLICY, days: [7, 7] },
      'Los tramos van de menor a mayor, sin repetir días.',
    ],
    [
      { ...POLICY, maxNotices: 0 },
      'El máximo de avisos por deuda va de 1 a 10.',
    ],
    [
      { ...POLICY, maxNotices: 11 },
      'El máximo de avisos por deuda va de 1 a 10.',
    ],
    [
      { ...POLICY, minGapDays: 0 },
      'Los días mínimos entre avisos van de 1 a 90.',
    ],
    [
      { ...POLICY, minGapDays: 91 },
      'Los días mínimos entre avisos van de 1 a 90.',
    ],
  ])('rechaza %j', (policy, message) => {
    expect(policyError(policy)).toBe(message);
  });
});
