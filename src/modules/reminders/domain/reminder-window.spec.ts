import {
  REMINDER_CATCH_UP_MS,
  REMINDER_LOOKAHEAD_MS,
  decideReminder,
  isInSweepWindow,
  reminderDueAt,
  reminderIdempotencyKey,
  type ReminderDecisionInput,
} from './reminder-window';

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('ventanas del recordatorio (DX-026)', () => {
  it('la hora del recordatorio es el inicio menos la antelación', () => {
    expect(reminderDueAt(new Date('2026-10-22T14:00:00.000Z'), 48)).toEqual(
      new Date('2026-10-20T14:00:00.000Z'),
    );
    expect(reminderDueAt(new Date('2026-10-22T14:00:00.000Z'), 2)).toEqual(
      new Date('2026-10-22T12:00:00.000Z'),
    );
  });

  it('el barrido encola lo que toca en los próximos minutos (con margen) y no antes', () => {
    // 48 h antes cae dentro de la ventana de previsión: se encola ya, con runAt.
    expect(isInSweepWindow(at(48 * HOUR + 5 * MIN), 48, NOW)).toBe(true);
    // Justo en el borde de la previsión: todavía sí.
    expect(
      isInSweepWindow(at(48 * HOUR + REMINDER_LOOKAHEAD_MS), 48, NOW),
    ).toBe(true);
    // Más allá: lo encolará un barrido posterior.
    expect(
      isInSweepWindow(at(48 * HOUR + REMINDER_LOOKAHEAD_MS + 1), 48, NOW),
    ).toBe(false);
  });

  it('recupera un recordatorio atrasado (worker caído) solo dentro del margen', () => {
    expect(isInSweepWindow(at(2 * HOUR - 30 * MIN), 2, NOW)).toBe(true);
    expect(isInSweepWindow(at(2 * HOUR - REMINDER_CATCH_UP_MS), 2, NOW)).toBe(
      false,
    );
  });

  it('nunca para una cita que ya empezó', () => {
    // Antelación de 1 h y la cita empezó hace 1 min: la hora del recordatorio
    // cae dentro del margen, pero ya no tiene sentido.
    expect(isInSweepWindow(at(-MIN), 1, NOW)).toBe(false);
  });

  it('la clave de idempotencia es por cita, antelación y hora de inicio', () => {
    const id = '7d5e3a9e-0c9b-4bb5-9c1e-2a0c3f6b8f10';
    const start = new Date('2026-10-22T14:00:00.000Z');
    expect(reminderIdempotencyKey(id, 48, start)).toBe(
      `reminder:${id}:48h:2026-10-22T14:00:00.000Z`,
    );
    // Reprogramada: otra clave, así que se vuelve a calcular.
    expect(
      reminderIdempotencyKey(id, 48, new Date('2026-10-23T14:00:00.000Z')),
    ).not.toBe(reminderIdempotencyKey(id, 48, start));
  });
});

describe('decideReminder (DX-026)', () => {
  const start = at(2 * HOUR);
  const base: ReminderDecisionInput = {
    appointment: { status: 'SCHEDULED', start, deleted: false },
    expectedStart: start,
    leadHours: 2,
    settings: { enabled: true, leadHours: [48, 2] },
    contact: {
      contactChannel: 'EMAIL',
      reminderOptOutAt: null,
      email: 'ana@example.com',
    },
    now: NOW,
  };
  const contact = (over: Partial<ReminderDecisionInput['contact']>) => ({
    ...base.contact,
    ...over,
  });

  it('envía a una cita agendada o confirmada, a su hora y con email', () => {
    expect(decideReminder(base)).toEqual({ action: 'SEND' });
    expect(
      decideReminder({
        ...base,
        appointment: { ...base.appointment, status: 'CONFIRMED' },
      }),
    ).toEqual({ action: 'SEND' });
  });

  it.each([
    ['CANCELLED', 'CANCELLED'],
    ['COMPLETED', 'COMPLETED'],
    ['NO_SHOW', 'NO_SHOW'],
  ] as const)('omite una cita %s', (status, reason) => {
    expect(
      decideReminder({ ...base, appointment: { ...base.appointment, status } }),
    ).toEqual({ action: 'SKIP', reason });
  });

  it('omite una cita retirada', () => {
    expect(
      decideReminder({
        ...base,
        appointment: { ...base.appointment, deleted: true },
      }),
    ).toEqual({ action: 'SKIP', reason: 'DELETED' });
  });

  it('omite si la cita se reprogramó a otra hora', () => {
    expect(
      decideReminder({
        ...base,
        appointment: { ...base.appointment, start: at(26 * HOUR) },
      }),
    ).toEqual({ action: 'SKIP', reason: 'RESCHEDULED' });
  });

  it('omite si la sede desactivó los recordatorios o quitó esa antelación', () => {
    expect(
      decideReminder({ ...base, settings: { enabled: false, leadHours: [2] } }),
    ).toEqual({ action: 'SKIP', reason: 'DISABLED' });
    expect(
      decideReminder({ ...base, settings: { enabled: true, leadHours: [24] } }),
    ).toEqual({ action: 'SKIP', reason: 'DISABLED' });
    expect(decideReminder({ ...base, settings: null })).toEqual({
      action: 'SKIP',
      reason: 'DISABLED',
    });
  });

  it('omite si la cita ya empezó', () => {
    expect(decideReminder({ ...base, now: at(2 * HOUR) })).toEqual({
      action: 'SKIP',
      reason: 'TOO_LATE',
    });
  });

  it('omite uno atrasado más allá del margen (worker caído): no llega a deshora', () => {
    // El de 48 h de una cita dentro de 2 h: su hora pasó hace 46 h.
    expect(decideReminder({ ...base, leadHours: 48 })).toEqual({
      action: 'SKIP',
      reason: 'TOO_LATE',
    });
    // Dentro del margen de recuperación sí sale.
    const due = reminderDueAt(start, 2).getTime();
    expect(
      decideReminder({
        ...base,
        now: new Date(due + REMINDER_CATCH_UP_MS - MIN),
      }),
    ).toEqual({ action: 'SEND' });
    expect(
      decideReminder({ ...base, now: new Date(due + REMINDER_CATCH_UP_MS) }),
    ).toEqual({ action: 'SKIP', reason: 'TOO_LATE' });
  });

  it('omite si el paciente no tiene email (o es solo espacios)', () => {
    expect(
      decideReminder({ ...base, contact: contact({ email: null }) }),
    ).toEqual({
      action: 'SKIP',
      reason: 'NO_EMAIL',
    });
    expect(
      decideReminder({ ...base, contact: contact({ email: '   ' }) }),
    ).toEqual({
      action: 'SKIP',
      reason: 'NO_EMAIL',
    });
  });

  it('el estado de la cita manda sobre la falta de email (motivo más útil)', () => {
    expect(
      decideReminder({
        ...base,
        appointment: { ...base.appointment, status: 'CANCELLED' },
        contact: contact({ email: null }),
      }),
    ).toEqual({ action: 'SKIP', reason: 'CANCELLED' });
  });

  // DX-128: la preferencia del paciente se relee al enviar.
  it('omite si el paciente se dio de baja después de encolarse', () => {
    expect(
      decideReminder({
        ...base,
        contact: contact({ reminderOptOutAt: at(-HOUR) }),
      }),
    ).toEqual({ action: 'SKIP', reason: 'OPTED_OUT' });
  });

  it.each([
    ['NONE', 'CHANNEL_NONE'],
    ['WHATSAPP', 'CHANNEL_WHATSAPP'],
  ] as const)('omite el email si el canal es %s', (contactChannel, reason) => {
    expect(
      decideReminder({ ...base, contact: contact({ contactChannel }) }),
    ).toEqual({ action: 'SKIP', reason });
  });

  it('el estado de la cita manda también sobre la baja', () => {
    expect(
      decideReminder({
        ...base,
        appointment: { ...base.appointment, status: 'NO_SHOW' },
        contact: contact({ reminderOptOutAt: at(-HOUR) }),
      }),
    ).toEqual({ action: 'SKIP', reason: 'NO_SHOW' });
  });
});
