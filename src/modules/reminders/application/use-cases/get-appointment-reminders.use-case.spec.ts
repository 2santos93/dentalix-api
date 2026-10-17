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
    expect(
      result.items.map((i) => [i.leadHours, i.state, i.skipReason]),
    ).toEqual([
      [48, 'SKIPPED', 'NO_EMAIL'],
      [2, 'PENDING', null],
    ]);
  });
});
