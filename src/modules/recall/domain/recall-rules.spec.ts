import {
  addCivilMonths,
  civilDayDiff,
  isOnCallList,
  recallState,
  type RecallFacts,
} from './recall-rules';

/** «Control cada 6 meses» desde el 10/04: la BD guarda dueAt = 10/10. */
const facts = (over: Partial<RecallFacts> = {}): RecallFacts => ({
  lastDoneAt: '2026-04-10',
  dueAt: '2026-10-10',
  active: true,
  disabledUntil: null,
  hasUpcomingAppointment: false,
  archived: false,
  ...over,
});

describe('addCivilMonths (DX-015)', () => {
  it.each([
    ['2026-04-10', 6, '2026-10-10'],
    ['2026-04-10', 3, '2026-07-10'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2028-02-29', 48 - 36, '2029-02-28'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-10-31', 1, '2026-11-30'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-11-30', 3, '2027-02-28'],
    ['2026-05-31', 36, '2029-05-31'],
  ])('%s + %i meses = %s', (day, months, expected) => {
    expect(addCivilMonths(day, months)).toBe(expected);
  });

  it('rechaza un día que no existe', () => {
    expect(() => addCivilMonths('2026-02-30', 1)).toThrow(RangeError);
  });
});

describe('civilDayDiff', () => {
  it('cuenta en los dos sentidos', () => {
    expect(civilDayDiff('2026-10-10', '2026-10-10')).toBe(0);
    expect(civilDayDiff('2026-10-10', '2026-10-25')).toBe(15);
    expect(civilDayDiff('2026-10-25', '2026-10-10')).toBe(-15);
    expect(civilDayDiff('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('recallState (DX-015)', () => {
  it('«control cada 6 meses» el 10/04 vence el 10/10 y entra ese día', () => {
    expect(recallState(facts(), '2026-10-09')).toMatchObject({
      dueAt: '2026-10-10',
      status: 'UPCOMING',
      daysOverdue: -1,
    });
    expect(recallState(facts(), '2026-10-10')).toMatchObject({
      dueAt: '2026-10-10',
      status: 'DUE',
      daysOverdue: 0,
    });
    expect(recallState(facts(), '2026-11-01')).toMatchObject({
      status: 'DUE',
      daysOverdue: 22,
    });
  });

  it('el vencimiento es el guardado (columna generada), no se recalcula', () => {
    const s = recallState(facts({ dueAt: '2026-07-10' }), '2026-07-10');
    expect(s).toMatchObject({
      baseDate: '2026-04-10',
      dueAt: '2026-07-10',
      status: 'DUE',
      daysOverdue: 0,
    });
  });

  it('vencido CON cita futura no se llama (SCHEDULED); sin ella, sí', () => {
    const today = '2026-11-01';
    expect(
      recallState(facts({ hasUpcomingAppointment: true }), today).status,
    ).toBe('SCHEDULED');
    expect(isOnCallList(facts({ hasUpcomingAppointment: true }), today)).toBe(
      false,
    );
    // Al cancelarse la cita, vuelve.
    expect(isOnCallList(facts({ hasUpcomingAppointment: false }), today)).toBe(
      true,
    );
  });

  it('DX-015-bis: la base es la del recall (lo fijado o el último DONE de un disparador)', () => {
    // Un DONE de profilaxis el 20/09 deja lastDoneAt = 20/09 y dueAt = 20/03.
    const s = recallState(
      facts({ lastDoneAt: '2026-09-20', dueAt: '2027-03-20' }),
      '2026-11-01',
    );
    expect(s).toMatchObject({
      baseDate: '2026-09-20',
      dueAt: '2027-03-20',
      status: 'UPCOMING',
    });
  });

  it('desactivado hasta un día no aparece hasta ese día', () => {
    const paused = facts({ disabledUntil: '2026-12-01' });
    expect(recallState(paused, '2026-11-01').status).toBe('PAUSED');
    expect(isOnCallList(paused, '2026-11-30')).toBe(false);
    expect(isOnCallList(paused, '2026-12-01')).toBe(true);
  });

  it('retirado o paciente archivado: INACTIVE, nunca en la lista', () => {
    expect(recallState(facts({ active: false }), '2026-11-01').status).toBe(
      'INACTIVE',
    );
    expect(isOnCallList(facts({ archived: true }), '2026-11-01')).toBe(false);
  });

  it('«vence pronto»: entra con la ventana, pero la pausa se mide con hoy', () => {
    const today = '2026-10-01';
    expect(isOnCallList(facts(), today)).toBe(false);
    expect(isOnCallList(facts(), today, 9)).toBe(true);
    expect(isOnCallList(facts(), today, 8)).toBe(false);
    expect(
      isOnCallList(facts({ disabledUntil: '2026-10-05' }), today, 30),
    ).toBe(false);
  });
});
