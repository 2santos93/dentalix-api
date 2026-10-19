import { buildReminderTimeline } from './reminder-timeline';
import type { ReminderRecord } from './reminder-timeline';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('buildReminderTimeline (DX-026)', () => {
  const start = at(30 * HOUR);

  it('enviado, pendiente y omitido de la hora vigente, de más a menos antelación', () => {
    const sent: ReminderRecord = {
      leadHours: 48,
      appointmentStart: start,
      status: 'SENT',
      skipReason: null,
      sentAt: at(-18 * HOUR),
      emailDelivery: 'SENT',
    };
    const items = buildReminderTimeline({
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48, 24, 2] },
      records: [sent],
      now: NOW,
    });
    expect(items).toEqual([
      {
        leadHours: 48,
        appointmentStart: start,
        dueAt: at(-18 * HOUR),
        state: 'SENT',
        sentAt: at(-18 * HOUR),
        skipReason: null,
        emailDelivery: 'SENT',
        sentToResponsible: false,
        current: true,
      },
      {
        leadHours: 24,
        appointmentStart: start,
        dueAt: at(6 * HOUR),
        state: 'PENDING',
        sentAt: null,
        skipReason: null,
        emailDelivery: null,
        sentToResponsible: false,
        current: true,
      },
      {
        leadHours: 2,
        appointmentStart: start,
        dueAt: at(28 * HOUR),
        state: 'PENDING',
        sentAt: null,
        skipReason: null,
        emailDelivery: null,
        sentToResponsible: false,
        current: true,
      },
    ]);
  });

  it('DX-203: un recordatorio que salió al responsable lo dice', () => {
    const items = buildReminderTimeline({
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48] },
      records: [
        {
          leadHours: 48,
          appointmentStart: start,
          status: 'SENT',
          skipReason: null,
          sentAt: at(-18 * HOUR),
          emailDelivery: 'PENDING',
          sentToResponsible: true,
        },
      ],
      now: NOW,
    });
    expect(items).toMatchObject([{ state: 'SENT', sentToResponsible: true }]);
  });

  it('una antelación cuya hora pasó sin registro (cita agendada tarde) sale como no enviada', () => {
    const soon = at(3 * HOUR);
    const items = buildReminderTimeline({
      appointment: { start: soon, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48, 2] },
      records: [],
      now: NOW,
    });
    expect(items.map((i) => [i.leadHours, i.state])).toEqual([
      [48, 'MISSED'],
      [2, 'PENDING'],
    ]);
  });

  it('sin pendientes si la cita no sigue en pie o la sede los tiene desactivados', () => {
    // DX-200: tampoco con el paciente ya en la clínica.
    for (const status of [
      'CANCELLED',
      'COMPLETED',
      'NO_SHOW',
      'ARRIVED',
      'IN_CHAIR',
      'READY_FOR_CHECKOUT',
    ] as const) {
      expect(
        buildReminderTimeline({
          appointment: { start, status, deleted: false },
          settings: { enabled: true, leadHours: [48, 2] },
          records: [],
          now: NOW,
        }),
      ).toEqual([]);
    }
    expect(
      buildReminderTimeline({
        appointment: { start, status: 'SCHEDULED', deleted: false },
        settings: { enabled: false, leadHours: [48] },
        records: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('los registros de una hora anterior (reprogramada) van al final y no cuentan como vigentes', () => {
    const old = at(10 * HOUR);
    const items = buildReminderTimeline({
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [2] },
      records: [
        {
          leadHours: 2,
          appointmentStart: old,
          status: 'SKIPPED',
          skipReason: 'RESCHEDULED',
          sentAt: null,
          emailDelivery: null,
        },
      ],
      now: NOW,
    });
    expect(items.map((i) => [i.state, i.current, i.skipReason])).toEqual([
      ['PENDING', true, null],
      ['SKIPPED', false, 'RESCHEDULED'],
    ]);
  });

  it('un registro aún enviándose se muestra como tal', () => {
    const items = buildReminderTimeline({
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48] },
      records: [
        {
          leadHours: 48,
          appointmentStart: start,
          status: 'SENDING',
          skipReason: null,
          sentAt: null,
          emailDelivery: null,
        },
      ],
      now: NOW,
    });
    expect(items.map((i) => i.state)).toEqual(['SENDING']);
  });
});
