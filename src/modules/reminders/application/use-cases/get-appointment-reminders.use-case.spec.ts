import { NotFoundException } from '@nestjs/common';
import { FakeReminderRepository } from '../__fixtures__/fake-reminder.repository';
import { GetAppointmentRemindersUseCase } from './get-appointment-reminders.use-case';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('GetAppointmentRemindersUseCase (DX-026)', () => {
  it('404 en español si la cita no es de esta clínica', async () => {
    const uc = new GetAppointmentRemindersUseCase(
      new FakeReminderRepository(),
      { now: () => NOW },
    );
    await expect(uc.execute('x')).rejects.toThrow(
      new NotFoundException('Cita no encontrada'),
    );
  });

  it('devuelve los ajustes de la sede y la línea de recordatorios', async () => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48, 2] },
      contact: {
        contactChannel: 'EMAIL',
        reminderOptOutAt: null,
        email: 'ana@example.com',
      },
      records: [
        {
          leadHours: 48,
          appointmentStart: start,
          status: 'SKIPPED',
          skipReason: 'NO_EMAIL',
          sentAt: null,
          emailDelivery: null,
        },
      ],
    };
    const result = await new GetAppointmentRemindersUseCase(repo, {
      now: () => NOW,
    }).execute('a-1');
    expect(result.enabled).toBe(true);
    expect(result.leadHours).toEqual([48, 2]);
    expect(result.patientBlocker).toBeNull();
    expect(
      result.items.map((i) => [i.leadHours, i.state, i.skipReason]),
    ).toEqual([
      [48, 'SKIPPED', 'NO_EMAIL'],
      [2, 'PENDING', null],
    ]);
  });

  // DX-128: un paciente con baja o con otro canal no tiene nada pendiente por
  // email; el panel lo dice en vez de mostrar «Pendiente» y luego «No salió».
  it.each([
    [{ reminderOptOutAt: new Date(NOW.getTime() - HOUR) }, 'OPTED_OUT'],
    [{ contactChannel: 'NONE' as const }, 'CHANNEL_NONE'],
    [{ contactChannel: 'WHATSAPP' as const }, 'CHANNEL_WHATSAPP'],
  ])('con %j no fabrica pendientes y explica el motivo', async (over, why) => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    const sent = {
      leadHours: 48,
      appointmentStart: start,
      status: 'SENT' as const,
      skipReason: null,
      sentAt: new Date(NOW.getTime() - 18 * HOUR),
      emailDelivery: 'SENT' as const,
    };
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [48, 2] },
      contact: {
        contactChannel: 'EMAIL',
        reminderOptOutAt: null,
        email: 'ana@example.com',
        ...over,
      },
      records: [sent],
    };
    const result = await new GetAppointmentRemindersUseCase(repo, {
      now: () => NOW,
    }).execute('a-1');
    expect(result.patientBlocker).toBe(why);
    // Lo ya enviado se sigue viendo; lo que faltaba ya no sale.
    expect(result.items.map((i) => [i.leadHours, i.state])).toEqual([
      [48, 'SENT'],
    ]);
  });

  it('sin email sigue como antes: pendiente y, al llegar su hora, NO_EMAIL', async () => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      settings: { enabled: true, leadHours: [2] },
      contact: { contactChannel: 'EMAIL', reminderOptOutAt: null, email: null },
      records: [],
    };
    const result = await new GetAppointmentRemindersUseCase(repo, {
      now: () => NOW,
    }).execute('a-1');
    expect(result.patientBlocker).toBeNull();
    expect(result.items.map((i) => i.state)).toEqual(['PENDING']);
  });
});
