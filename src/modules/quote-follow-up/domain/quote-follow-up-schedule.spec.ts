import {
  contactBlocker,
  decideFollowUp,
  inSendWindow,
  planNextStep,
  stepDueDay,
  TOO_LATE_AFTER_DAYS,
  type FollowUpContactFacts,
  type FollowUpGroupFacts,
  type FollowUpPlanFacts,
  type FollowUpSettingsFacts,
  type RecordedStep,
} from './quote-follow-up-schedule';

const CARACAS = 'America/Caracas'; // UTC−4 fijo
const NEW_YORK = 'America/New_York'; // cambio de hora el 2026-11-01

/** Instante de la hora de pared `hh:mm` del día `day` en Caracas. */
const caracas = (day: string, hhmm = '11:00') => {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + 4, min));
};

const OFFSETS = [3, 10, 21];

describe('stepDueDay', () => {
  it('suma los días del paso al día civil de la presentación', () => {
    expect(stepDueDay('2026-11-15', OFFSETS, 1)).toBe('2026-11-18');
    expect(stepDueDay('2026-11-15', OFFSETS, 2)).toBe('2026-11-25');
    expect(stepDueDay('2026-11-15', OFFSETS, 3)).toBe('2026-12-06');
  });

  it('cruza meses y años (días civiles, no horas)', () => {
    expect(stepDueDay('2026-12-28', [3, 10, 21], 1)).toBe('2026-12-31');
    expect(stepDueDay('2026-12-28', [3, 10, 21], 2)).toBe('2027-01-07');
    expect(stepDueDay('2028-02-27', [2], 1)).toBe('2028-02-29');
  });
});

describe('planNextStep', () => {
  const base = { presentedDay: '2026-11-15', offsetsDays: OFFSETS };
  const sent = (step: number): RecordedStep => ({
    step,
    status: 'SENT',
    reason: null,
  });

  it('nada antes del primer día', () => {
    expect(planNextStep({ ...base, recorded: [], today: '2026-11-17' })).toBe(
      null,
    );
  });

  it('el día del paso 1 toca el paso 1, sin atrasados', () => {
    expect(
      planNextStep({ ...base, recorded: [], today: '2026-11-18' }),
    ).toEqual({
      step: 1,
      dueDay: '2026-11-18',
      superseded: [],
      tooLate: false,
    });
  });

  it('el paso 1 ya registrado: el siguiente no toca hasta su día', () => {
    expect(
      planNextStep({ ...base, recorded: [sent(1)], today: '2026-11-24' }),
    ).toBe(null);
    expect(
      planNextStep({ ...base, recorded: [sent(1)], today: '2026-11-25' }),
    ).toMatchObject({ step: 2, superseded: [] });
  });

  it('activar el ajuste tarde: sale solo el de mayor índice vencido y los anteriores quedan SUPERSEDED', () => {
    expect(
      planNextStep({ ...base, recorded: [], today: '2026-11-26' }),
    ).toEqual({
      step: 2,
      dueDay: '2026-11-25',
      superseded: [1],
      tooLate: false,
    });
    expect(
      planNextStep({ ...base, recorded: [], today: '2026-12-06' }),
    ).toEqual({
      step: 3,
      dueDay: '2026-12-06',
      superseded: [1, 2],
      tooLate: false,
    });
  });

  it(`vencido hace más de ${TOO_LATE_AFTER_DAYS} días: TOO_LATE (7 días justos aún sale)`, () => {
    expect(
      planNextStep({
        ...base,
        recorded: [sent(1), sent(2)],
        today: '2026-12-13',
      }),
    ).toMatchObject({ step: 3, tooLate: false });
    expect(
      planNextStep({
        ...base,
        recorded: [sent(1), sent(2)],
        today: '2026-12-14',
      }),
    ).toMatchObject({ step: 3, tooLate: true });
  });

  it('nunca más de 3 pasos ni más que los días configurados', () => {
    const all = [sent(1), sent(2), sent(3)];
    expect(planNextStep({ ...base, recorded: all, today: '2027-06-01' })).toBe(
      null,
    );
    expect(
      planNextStep({
        presentedDay: '2026-11-15',
        offsetsDays: [5],
        recorded: [sent(1)],
        today: '2027-06-01',
      }),
    ).toBe(null);
    expect(
      planNextStep({
        presentedDay: '2026-11-15',
        offsetsDays: [1, 2, 3, 4],
        recorded: [],
        today: '2027-06-01',
      }),
    ).toMatchObject({ step: 3, superseded: [1, 2] });
  });

  it('nunca vuelve atrás: solo pasos posteriores al último registrado', () => {
    expect(
      planNextStep({
        ...base,
        recorded: [{ step: 2, status: 'SKIPPED', reason: 'OPTED_OUT' }],
        today: '2026-11-30',
      }),
    ).toBe(null);
  });

  it('una parada o el vencimiento registrados cierran la secuencia', () => {
    for (const reason of [
      'STOPPED_ACCEPTED',
      'STOPPED_REJECTED',
      'STOPPED_SCHEDULED',
      'EXPIRED',
    ] as const) {
      expect(
        planNextStep({
          ...base,
          recorded: [sent(1), { step: 2, status: 'SKIPPED', reason }],
          today: '2026-12-06',
        }),
      ).toBe(null);
    }
  });

  it('una omisión del paciente NO cierra la secuencia', () => {
    expect(
      planNextStep({
        ...base,
        recorded: [{ step: 1, status: 'SKIPPED', reason: 'NO_EMAIL' }],
        today: '2026-11-25',
      }),
    ).toMatchObject({ step: 2 });
  });
});

describe('inSendWindow', () => {
  it('[desde, hasta) en la hora de pared de la sede', () => {
    expect(inSendWindow(caracas('2026-11-18', '08:59'), CARACAS, 9, 19)).toBe(
      false,
    );
    expect(inSendWindow(caracas('2026-11-18', '09:00'), CARACAS, 9, 19)).toBe(
      true,
    );
    expect(inSendWindow(caracas('2026-11-18', '18:59'), CARACAS, 9, 19)).toBe(
      true,
    );
    expect(inSendWindow(caracas('2026-11-18', '19:00'), CARACAS, 9, 19)).toBe(
      false,
    );
  });

  it('hasta las 24 = hasta la medianoche', () => {
    expect(inSendWindow(caracas('2026-11-18', '23:59'), CARACAS, 20, 24)).toBe(
      true,
    );
    expect(inSendWindow(caracas('2026-11-19', '00:00'), CARACAS, 20, 24)).toBe(
      false,
    );
  });

  it('con el cambio de hora la franja sigue el reloj local (Nueva York, 1 nov 2026)', () => {
    // Sábado 31 oct (EDT, UTC−4): 9:00 local = 13:00 UTC.
    expect(
      inSendWindow(new Date('2026-10-31T12:59:00Z'), NEW_YORK, 9, 19),
    ).toBe(false);
    expect(
      inSendWindow(new Date('2026-10-31T13:00:00Z'), NEW_YORK, 9, 19),
    ).toBe(true);
    // Domingo 1 nov (EST, UTC−5): 9:00 local = 14:00 UTC.
    expect(
      inSendWindow(new Date('2026-11-01T13:30:00Z'), NEW_YORK, 9, 19),
    ).toBe(false);
    expect(
      inSendWindow(new Date('2026-11-01T14:00:00Z'), NEW_YORK, 9, 19),
    ).toBe(true);
    expect(
      inSendWindow(new Date('2026-11-01T23:59:00Z'), NEW_YORK, 9, 19),
    ).toBe(true);
    expect(
      inSendWindow(new Date('2026-11-02T00:00:00Z'), NEW_YORK, 9, 19),
    ).toBe(false);
  });
});

describe('contactBlocker', () => {
  const ok: FollowUpContactFacts = {
    contactChannel: 'EMAIL',
    reminderOptOutAt: null,
    consentRevoked: false,
  };

  it('baja, canal, WhatsApp y consentimiento revocado, en ese orden', () => {
    expect(contactBlocker(ok)).toBe(null);
    expect(
      contactBlocker({
        ...ok,
        reminderOptOutAt: new Date(),
        contactChannel: 'NONE',
      }),
    ).toBe('OPTED_OUT');
    expect(contactBlocker({ ...ok, contactChannel: 'NONE' })).toBe(
      'CHANNEL_NONE',
    );
    expect(contactBlocker({ ...ok, contactChannel: 'WHATSAPP' })).toBe(
      'CHANNEL_WHATSAPP',
    );
    expect(contactBlocker({ ...ok, consentRevoked: true })).toBe('NO_CONSENT');
  });
});

describe('decideFollowUp', () => {
  const settings: FollowUpSettingsFacts = {
    enabled: true,
    offsetsDays: OFFSETS,
    sendFromHour: 9,
    sendUntilHour: 19,
    timeZone: CARACAS,
  };
  const contact: FollowUpContactFacts = {
    contactChannel: 'EMAIL',
    reminderOptOutAt: null,
    consentRevoked: false,
  };
  const plan = (over: Partial<FollowUpPlanFacts> = {}): FollowUpPlanFacts => ({
    id: 'p-a',
    status: 'PRESENTED',
    quoteValidUntil: null,
    presentedAt: caracas('2026-11-15', '10:00'),
    paused: false,
    accepted: false,
    itemCount: 2,
    ...over,
  });
  const group = (
    over: Partial<FollowUpGroupFacts> = {},
  ): FollowUpGroupFacts => ({
    groupId: 'p-a',
    patientId: 'pa',
    locationId: 'loc',
    presentedAt: caracas('2026-11-15', '10:00'),
    plans: [plan()],
    recorded: [],
    scheduled: false,
    ...over,
  });
  const at = caracas('2026-11-18', '10:00');
  const sentStep1: RecordedStep = { step: 1, status: 'SENT', reason: null };

  it('presentado hace 3 días con 3/10/21: SEND del paso 1', () => {
    expect(
      decideFollowUp({ now: at, group: group(), settings, contact }),
    ).toEqual({ kind: 'SEND', step: 1, superseded: [], planIds: ['p-a'] });
  });

  it('sin ajustes, apagado o fuera de la franja: nada', () => {
    expect(
      decideFollowUp({ now: at, group: group(), settings: null, contact }),
    ).toEqual({ kind: 'NOOP', why: 'DISABLED' });
    expect(
      decideFollowUp({
        now: at,
        group: group(),
        settings: { ...settings, enabled: false },
        contact,
      }),
    ).toEqual({ kind: 'NOOP', why: 'DISABLED' });
    expect(
      decideFollowUp({
        now: caracas('2026-11-18', '20:00'),
        group: group(),
        settings,
        contact,
      }),
    ).toEqual({ kind: 'NOOP', why: 'OUTSIDE_WINDOW' });
  });

  it('A/B: las opciones presentadas en su orden; la rechazada no va', () => {
    const d = decideFollowUp({
      now: at,
      group: group({
        plans: [
          plan({ id: 'p-b', presentedAt: caracas('2026-11-15', '10:05') }),
          plan({ id: 'p-a' }),
          plan({ id: 'p-c', status: 'REJECTED' }),
        ],
      }),
      settings,
      contact,
    });
    expect(d).toMatchObject({ kind: 'SEND', planIds: ['p-a', 'p-b'] });
  });

  it('aceptado, todo rechazado o agendado: la parada solo se registra si ya se envió alguno', () => {
    const accepted = group({
      plans: [plan({ status: 'ACCEPTED', accepted: true })],
    });
    expect(
      decideFollowUp({ now: at, group: accepted, settings, contact }),
    ).toEqual({ kind: 'NOOP', why: 'NOT_OPEN' });
    const later = caracas('2026-11-25', '10:00');
    expect(
      decideFollowUp({
        now: later,
        group: { ...accepted, recorded: [sentStep1] },
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SKIP', step: 2, reason: 'STOPPED_ACCEPTED' });
    expect(
      decideFollowUp({
        now: later,
        group: group({
          plans: [plan({ status: 'REJECTED' })],
          recorded: [sentStep1],
        }),
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SKIP', step: 2, reason: 'STOPPED_REJECTED' });
    expect(
      decideFollowUp({
        now: later,
        group: group({ scheduled: true, recorded: [sentStep1] }),
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SKIP', step: 2, reason: 'STOPPED_SCHEDULED' });
    expect(
      decideFollowUp({
        now: at,
        group: group({ scheduled: true }),
        settings,
        contact,
      }),
    ).toEqual({ kind: 'NOOP', why: 'WAITING_APPOINTMENT' });
  });

  it('una opción aceptada detiene aunque la otra siga presentada', () => {
    expect(
      decideFollowUp({
        now: caracas('2026-11-25', '10:00'),
        group: group({
          plans: [plan({ id: 'p-a', accepted: true }), plan({ id: 'p-b' })],
          recorded: [sentStep1],
        }),
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SKIP', reason: 'STOPPED_ACCEPTED' });
  });

  it('pausado: nada y no consume el paso', () => {
    expect(
      decideFollowUp({
        now: at,
        group: group({ plans: [plan({ paused: true })] }),
        settings,
        contact,
      }),
    ).toEqual({ kind: 'NOOP', why: 'PAUSED' });
  });

  it('vencido en el día civil de la sede: EXPIRED (el último día aún sale)', () => {
    expect(
      decideFollowUp({
        now: at,
        group: group({ plans: [plan({ quoteValidUntil: '2026-11-18' })] }),
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SEND' });
    expect(
      decideFollowUp({
        now: at,
        group: group({ plans: [plan({ quoteValidUntil: '2026-11-17' })] }),
        settings,
        contact,
      }),
    ).toMatchObject({
      kind: 'SKIP',
      step: 1,
      reason: 'EXPIRED',
      planIds: ['p-a'],
    });
  });

  it('una opción vencida y otra vigente: solo va la vigente', () => {
    expect(
      decideFollowUp({
        now: at,
        group: group({
          plans: [
            plan({ id: 'p-a', quoteValidUntil: '2026-11-17' }),
            plan({ id: 'p-b', quoteValidUntil: '2026-12-15' }),
          ],
        }),
        settings,
        contact,
      }),
    ).toMatchObject({ kind: 'SEND', planIds: ['p-b'] });
  });

  it('baja, canal, WhatsApp y consentimiento revocado: SKIP con su motivo', () => {
    for (const [c, reason] of [
      [{ ...contact, reminderOptOutAt: new Date() }, 'OPTED_OUT'],
      [{ ...contact, contactChannel: 'NONE' as const }, 'CHANNEL_NONE'],
      [{ ...contact, contactChannel: 'WHATSAPP' as const }, 'CHANNEL_WHATSAPP'],
      [{ ...contact, consentRevoked: true }, 'NO_CONSENT'],
    ] as const) {
      expect(
        decideFollowUp({ now: at, group: group(), settings, contact: c }),
      ).toMatchObject({ kind: 'SKIP', step: 1, reason });
    }
  });

  it('demasiado tarde: TOO_LATE en el paso que tocaba, con los anteriores SUPERSEDED', () => {
    expect(
      decideFollowUp({
        now: caracas('2027-01-01', '10:00'),
        group: group(),
        settings,
        contact,
      }),
    ).toMatchObject({
      kind: 'SKIP',
      step: 3,
      superseded: [1, 2],
      reason: 'TOO_LATE',
    });
  });

  it('el día civil de la presentación es el de la sede, no el de UTC', () => {
    // 22:30 del 15 en Caracas = 02:30 UTC del 16: el paso 1 es el 18.
    const late = caracas('2026-11-15', '22:30');
    const g = group({
      presentedAt: late,
      plans: [plan({ presentedAt: late })],
    });
    expect(
      decideFollowUp({ now: at, group: g, settings, contact }),
    ).toMatchObject({ kind: 'SEND', step: 1 });
  });
});
