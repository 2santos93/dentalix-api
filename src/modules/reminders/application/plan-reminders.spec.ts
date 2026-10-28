import { FakeReminderRepository } from './__fixtures__/fake-reminder.repository';
import { PlanReminders, SEND_REMINDER_JOB } from './plan-reminders';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('PlanReminders (DX-026)', () => {
  it('encola un trabajo por cita y antelación, por clínica, a su hora y con clave idempotente', async () => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 48 * HOUR + 5 * 60_000);
    const late = new Date(NOW.getTime() + 2 * HOUR - 10 * 60_000);
    repo.candidates = {
      'tenant-a': [
        { appointmentId: 'a-1', leadHours: 48, start },
        { appointmentId: 'a-2', leadHours: 2, start: late },
      ],
      'tenant-b': [],
    };
    const enqueue = jest.fn().mockResolvedValue({ id: 'j', created: true });
    const plan = new PlanReminders(repo, { enqueue } as never, {
      now: () => NOW,
    });

    expect(await plan.run()).toBe(2);
    expect(enqueue).toHaveBeenCalledWith(
      SEND_REMINDER_JOB,
      { appointmentId: 'a-1', leadHours: 48, start: start.toISOString() },
      {
        tenantId: 'tenant-a',
        runAt: new Date(NOW.getTime() + 5 * 60_000),
        idempotencyKey: `reminder:a-1:48h:${start.toISOString()}`,
      },
    );
    // Atrasado (dentro del margen): sale ya, no en el pasado. «Ya» lo pone la
    // BD (sin `runAt`): el reloj de la API puede ir por delante del suyo y
    // dejarlo «en el futuro» para el reclamo (DX-355).
    const calls = enqueue.mock.calls as [
      string,
      { appointmentId: string },
      Record<string, unknown>,
    ][];
    const lateOptions = calls.find(([, p]) => p.appointmentId === 'a-2')?.[2];
    expect(lateOptions).toMatchObject({ tenantId: 'tenant-a' });
    expect(lateOptions).not.toHaveProperty('runAt');
  });

  it('una clínica que falla no impide planificar las demás', async () => {
    const repo = new FakeReminderRepository();
    repo.candidates = { 'tenant-a': [], 'tenant-b': [] };
    const start = new Date(NOW.getTime() + 2 * HOUR);
    jest
      .spyOn(repo, 'dueCandidates')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ appointmentId: 'b-1', leadHours: 2, start }]);
    const enqueue = jest.fn().mockResolvedValue({ id: 'j', created: true });
    const plan = new PlanReminders(repo, { enqueue } as never, {
      now: () => NOW,
    });
    await expect(plan.run()).rejects.toThrow('1 clínica');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
