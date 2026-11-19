import type { RecallContactOutcome } from '@prisma/client';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  nextDueAfter,
  CALLBACK_ON_INVALID_MESSAGE,
  CALLBACK_ON_PAST_MESSAGE,
  CALLBACK_ON_TOO_FAR_MESSAGE,
  COUNTED_OUTCOMES,
  EMPTY_CYCLE,
  RECALL_SETTINGS_DEFAULTS,
  RECALL_SETTINGS_HIDE_DAYS_MESSAGE,
  RECALL_SETTINGS_MAX_ATTEMPTS_MESSAGE,
  callbackOnError,
  currentCycle,
  cycleView,
  nextCycleState,
  recallSettingsError,
  type RecallCycleState,
} from './recall-cycle';

// DX-465 (D1, D8): las transiciones del ciclo con el reloj de la sede
// inyectado. La sede es de Caracas (UTC−4, sin horario de verano): 23:30 del
// 10 de enero en la sede son las 03:30 UTC del 11.
const ZONE = 'America/Caracas';
const DUE = '2027-01-01';
const AT = new Date('2027-01-10T16:00:00.000Z'); // 12:00 en la sede
const LATE_NIGHT = new Date('2027-01-11T03:30:00.000Z'); // 23:30 del 10 en la sede

const fresh: RecallCycleState = { ...EMPTY_CYCLE, cycleDueAt: null };

const apply = (
  state: RecallCycleState,
  outcome: RecallContactOutcome,
  over: Partial<{ at: Date; dueAt: string; callbackOn: string | null }> = {},
) =>
  nextCycleState(state, {
    outcome,
    at: over.at ?? AT,
    dueAt: over.dueAt ?? DUE,
    intervalMonths: 6,
    today: civilDateIn(over.at ?? AT, ZONE),
    lastAttemptDay: state.lastAttemptAt
      ? civilDateIn(state.lastAttemptAt, ZONE)
      : null,
    callbackOn: over.callbackOn ?? null,
  });

/** Lo que ve la lista un día de la sede, con el día del intento en la sede. */
const view = (
  state: RecallCycleState,
  today: string,
  settings = RECALL_SETTINGS_DEFAULTS,
  dueAt = DUE,
) =>
  cycleView(state, {
    dueAt,
    intervalMonths: 6,
    today,
    lastAttemptDay: state.lastAttemptAt
      ? civilDateIn(state.lastAttemptAt, ZONE)
      : null,
    settings,
  });

describe('nextCycleState (DX-465, D1)', () => {
  it.each<RecallContactOutcome>([
    'NO_ANSWER',
    'LEFT_MESSAGE',
    'WILL_BOOK',
    'WRONG_NUMBER',
  ])(
    '%s cuenta un intento, apunta la hora y deja el ciclo en este vencimiento',
    (outcome) => {
      const once = apply(fresh, outcome);
      expect(once).toEqual({
        attemptCount: 1,
        lastAttemptAt: AT,
        callbackOn: null,
        skipUntil: null,
        cycleDueAt: DUE,
      });
      const later = new Date('2027-01-20T16:00:00.000Z');
      expect(apply(once, outcome, { at: later })).toMatchObject({
        attemptCount: 2,
        lastAttemptAt: later,
      });
    },
  );

  it('CALL_BACK cuenta y guarda la fecha; sin fecha, nada que guardar', () => {
    expect(apply(fresh, 'CALL_BACK', { callbackOn: '2027-01-15' })).toEqual({
      attemptCount: 1,
      lastAttemptAt: AT,
      callbackOn: '2027-01-15',
      skipUntil: null,
      cycleDueAt: DUE,
    });
    expect(apply(fresh, 'CALL_BACK')).toMatchObject({
      attemptCount: 1,
      callbackOn: null,
    });
  });

  it('un intento después de «Llamar luego» quita la fecha', () => {
    const callback = apply(fresh, 'CALL_BACK', { callbackOn: '2027-01-15' });
    expect(apply(callback, 'NO_ANSWER')).toMatchObject({
      attemptCount: 2,
      callbackOn: null,
    });
  });

  it('DECLINED pone el contador a 0 y salta hasta el vencimiento siguiente (vencimiento + intervalo del recall)', () => {
    const two = apply(apply(fresh, 'NO_ANSWER'), 'LEFT_MESSAGE');
    expect(apply(two, 'DECLINED')).toEqual({
      attemptCount: 0,
      lastAttemptAt: AT,
      callbackOn: null,
      skipUntil: '2027-07-01',
      cycleDueAt: DUE,
    });
    // Fin de mes: como Postgres (31/08 + 6 = 28/02).
    expect(apply(fresh, 'DECLINED', { dueAt: '2026-08-31' }).skipUntil).toBe(
      '2027-02-28',
    );
  });

  it('volver a llamar a quien rechazó quita el salto (se le llamó a propósito)', () => {
    const declined = apply(fresh, 'DECLINED');
    expect(apply(declined, 'NO_ANSWER')).toMatchObject({
      attemptCount: 1,
      skipUntil: null,
    });
  });

  it('BOOKED cierra el ciclo: contador a 0, sin último intento, sin ocultar', () => {
    const state = apply(apply(fresh, 'NO_ANSWER'), 'CALL_BACK', {
      callbackOn: '2027-01-20',
    });
    expect(apply(state, 'BOOKED')).toEqual({
      ...EMPTY_CYCLE,
      cycleDueAt: DUE,
    });
  });

  it('un vencimiento nuevo (se hizo el control) empieza el ciclo de cero', () => {
    const three = apply(
      apply(apply(fresh, 'NO_ANSWER'), 'NO_ANSWER'),
      'NO_ANSWER',
    );
    expect(three.attemptCount).toBe(3);
    expect(
      currentCycle(three, {
        dueAt: '2027-07-01',
        intervalMonths: 6,
        today: '2027-01-20',
        lastAttemptDay: '2027-01-10',
      }),
    ).toEqual({
      ...EMPTY_CYCLE,
      cycleDueAt: '2027-07-01',
    });
    expect(apply(three, 'NO_ANSWER', { dueAt: '2027-07-01' })).toMatchObject({
      attemptCount: 1,
      cycleDueAt: '2027-07-01',
    });
  });

  it('cuentan todos los desenlaces salvo los que cierran', () => {
    expect([...COUNTED_OUTCOMES].sort()).toEqual([
      'CALL_BACK',
      'LEFT_MESSAGE',
      'NO_ANSWER',
      'WILL_BOOK',
      'WRONG_NUMBER',
    ]);
  });
});

describe('cycleView: ocultación y tope con el día civil de la sede (DX-465, D1/D3)', () => {
  it('oculto hasta el día del intento + los días de la sede: vuelve ese día', () => {
    const once = apply(fresh, 'NO_ANSWER'); // 10/01 en la sede
    expect(view(once, '2027-01-10').hiddenUntil).toBe('2027-01-17');
    expect(view(once, '2027-01-16').hiddenUntil).toBe('2027-01-17');
    expect(view(once, '2027-01-17').hiddenUntil).toBeNull();
    expect(
      view(once, '2027-01-12', { hideDays: 2, maxAttempts: 3 }).hiddenUntil,
    ).toBeNull();
  });

  it('cambio de día civil: un intento a las 23:30 de la sede cuenta en ese día, no en el UTC', () => {
    const late = apply(fresh, 'NO_ANSWER', { at: LATE_NIGHT });
    expect(civilDateIn(LATE_NIGHT, 'UTC')).toBe('2027-01-11');
    expect(view(late, '2027-01-16').hiddenUntil).toBe('2027-01-17');
    expect(view(late, '2027-01-17').hiddenUntil).toBeNull();
  });

  it('«Llamar luego» oculta hasta su fecha (no los días de la sede)', () => {
    const callback = apply(fresh, 'CALL_BACK', { callbackOn: '2027-01-12' });
    expect(view(callback, '2027-01-11')).toMatchObject({
      hiddenUntil: '2027-01-12',
      callbackOn: '2027-01-12',
    });
    expect(view(callback, '2027-01-12').hiddenUntil).toBeNull();
    // Más lejos que los días de la sede también.
    const far = apply(fresh, 'CALL_BACK', { callbackOn: '2027-03-01' });
    expect(view(far, '2027-02-01').hiddenUntil).toBe('2027-03-01');
  });

  it('«Rechaza» no sale hasta el vencimiento siguiente', () => {
    const declined = apply(fresh, 'DECLINED');
    expect(view(declined, '2027-06-30')).toMatchObject({
      attempts: 0,
      hiddenUntil: '2027-07-01',
      exhausted: false,
    });
    expect(view(declined, '2027-07-01').hiddenUntil).toBeNull();
  });

  it('agotados: intentos del ciclo ≥ el tope de la sede', () => {
    let state = fresh;
    for (let i = 0; i < 3; i++) state = apply(state, 'NO_ANSWER');
    expect(view(state, '2027-02-01')).toMatchObject({
      attempts: 3,
      maxAttempts: 3,
      exhausted: true,
      hiddenUntil: null,
    });
    expect(
      view(state, '2027-02-01', { hideDays: 7, maxAttempts: 4 }).exhausted,
    ).toBe(false);
  });

  it('un estado de otro vencimiento no oculta ni cuenta', () => {
    const once = apply(fresh, 'NO_ANSWER');
    expect(
      view(once, '2027-01-11', RECALL_SETTINGS_DEFAULTS, '2027-07-01'),
    ).toEqual({
      attempts: 0,
      maxAttempts: 3,
      exhausted: false,
      lastAttemptDay: null,
      callbackOn: null,
      hiddenUntil: null,
    });
  });
});

describe('callbackOnError (DX-465)', () => {
  const TODAY = '2027-01-10';

  it.each([
    ['2027-01-10', null],
    ['2027-04-10', null],
    ['2027-04-11', CALLBACK_ON_TOO_FAR_MESSAGE],
    ['2027-01-09', CALLBACK_ON_PAST_MESSAGE],
    ['2027-02-30', CALLBACK_ON_INVALID_MESSAGE],
    ['10/01/2027', CALLBACK_ON_INVALID_MESSAGE],
  ])('%s → %s', (value, expected) => {
    expect(callbackOnError(value, TODAY)).toBe(expected);
  });
});

describe('recallSettingsError (DX-465, D2)', () => {
  it.each([
    [{ hideDays: 1, maxAttempts: 1 }, null],
    [{ hideDays: 90, maxAttempts: 10 }, null],
    [{ hideDays: 0, maxAttempts: 3 }, RECALL_SETTINGS_HIDE_DAYS_MESSAGE],
    [{ hideDays: 91, maxAttempts: 3 }, RECALL_SETTINGS_HIDE_DAYS_MESSAGE],
    [{ hideDays: 7.5, maxAttempts: 3 }, RECALL_SETTINGS_HIDE_DAYS_MESSAGE],
    [{ hideDays: 7, maxAttempts: 0 }, RECALL_SETTINGS_MAX_ATTEMPTS_MESSAGE],
    [{ hideDays: 7, maxAttempts: 11 }, RECALL_SETTINGS_MAX_ATTEMPTS_MESSAGE],
  ])('%j → %s', (input, expected) => {
    expect(recallSettingsError(input)).toBe(expected);
  });
});

describe('revisión DX-465: «Llamar luego» al tope, fin del ciclo y DST', () => {
  it('ruling 1: un «Llamar luego» que llega al tope no queda agotado: oculto hasta su día y entonces sale; el siguiente intento lo agota', () => {
    let state = apply(apply(fresh, 'NO_ANSWER'), 'NO_ANSWER');
    state = apply(state, 'CALL_BACK', { callbackOn: '2027-01-20' });
    expect(state.attemptCount).toBe(3);
    expect(view(state, '2027-01-15')).toMatchObject({
      exhausted: false,
      hiddenUntil: '2027-01-20',
    });
    expect(view(state, '2027-01-20')).toMatchObject({
      exhausted: false,
      hiddenUntil: null,
    });
    const after = apply(state, 'NO_ANSWER', {
      at: new Date('2027-01-20T16:00:00.000Z'),
    });
    expect(view(after, '2027-02-20')).toMatchObject({
      attempts: 4,
      exhausted: true,
    });
  });

  it('ruling 2: agotado hasta el vencimiento de la serie siguiente al último intento; ese día, ciclo nuevo con el contador a 0', () => {
    let state = fresh;
    for (let i = 0; i < 3; i += 1) state = apply(state, 'NO_ANSWER');
    // DUE 01/01/2027, intervalo 6: el siguiente al 10/01/2027 es el 01/07/2027.
    expect(view(state, '2027-06-30')).toMatchObject({ exhausted: true });
    expect(view(state, '2027-07-01')).toEqual({
      attempts: 0,
      maxAttempts: 3,
      exhausted: false,
      lastAttemptDay: null,
      callbackOn: null,
      hiddenUntil: null,
    });
    // Un intento ese día ya cuenta en el ciclo nuevo.
    const next = apply(state, 'NO_ANSWER', {
      at: new Date('2027-07-01T16:00:00.000Z'),
    });
    expect(next.attemptCount).toBe(1);
  });

  it('ruling 2: con un vencimiento muy pasado, el ciclo dura hasta el próximo de su serie (no uno ya pasado) y el «Rechaza» vuelve ese día', () => {
    const due = '2025-01-01';
    const at = new Date('2026-11-19T16:00:00.000Z');
    const state = apply(fresh, 'NO_ANSWER', { dueAt: due, at });
    expect(
      view(state, '2026-11-26', RECALL_SETTINGS_DEFAULTS, due),
    ).toMatchObject({ attempts: 1, hiddenUntil: null });
    expect(
      view(state, '2026-12-31', RECALL_SETTINGS_DEFAULTS, due).attempts,
    ).toBe(1);
    expect(
      view(state, '2027-01-01', RECALL_SETTINGS_DEFAULTS, due).attempts,
    ).toBe(0);
    expect(apply(fresh, 'DECLINED', { dueAt: due, at }).skipUntil).toBe(
      '2027-01-01',
    );
  });

  it.each([
    ['2025-01-31', 1, '2025-02-27', '2025-02-28'],
    ['2025-01-31', 1, '2025-02-28', '2025-03-31'],
    ['2025-01-01', 6, '2026-11-19', '2027-01-01'],
    ['2026-01-01', 6, '2025-11-19', '2026-07-01'],
    ['2025-08-31', 6, '2026-02-28', '2026-08-31'],
    ['2024-02-29', 12, '2025-01-10', '2025-02-28'],
  ])(
    'nextDueAfter(%s, %i, %s) = %s (como dx_recall_next_due_after)',
    (due, months, after, expected) => {
      expect(nextDueAfter(due, months, after)).toBe(expected);
    },
  );

  it('zona con horario de verano (America/New_York): el día del intento y la vuelta cruzan el cambio de hora sin correrse', () => {
    const NY = 'America/New_York';
    // 23:30 del sábado 06/03/2027 en Nueva York (EST, UTC−5) = 04:30Z del 07;
    // el domingo 14/03 empieza el horario de verano (EDT, UTC−4).
    const at = new Date('2027-03-07T04:30:00.000Z');
    expect(civilDateIn(at, NY)).toBe('2027-03-06');
    const state = nextCycleState(fresh, {
      outcome: 'NO_ANSWER',
      at,
      dueAt: DUE,
      intervalMonths: 6,
      today: civilDateIn(at, NY),
      lastAttemptDay: null,
      callbackOn: null,
    });
    const v = (today: string) =>
      cycleView(state, {
        dueAt: DUE,
        intervalMonths: 6,
        today,
        lastAttemptDay: civilDateIn(state.lastAttemptAt!, NY),
        settings: RECALL_SETTINGS_DEFAULTS,
      });
    expect(v('2027-03-12').hiddenUntil).toBe('2027-03-13');
    expect(v('2027-03-13').hiddenUntil).toBeNull();
    // 00:30 del domingo 14/03 en EST (05:30Z) también cuenta en su día.
    expect(civilDateIn(new Date('2027-03-14T05:30:00.000Z'), NY)).toBe(
      '2027-03-14',
    );
  });
});
