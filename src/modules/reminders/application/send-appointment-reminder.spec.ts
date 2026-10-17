import type { ReminderSendContext } from '../domain/ports/reminder-repository.port';
import { FakeReminderRepository } from './__fixtures__/fake-reminder.repository';
import { SendAppointmentReminder } from './send-appointment-reminder';
import type { ReminderClock } from './reminder-clock';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const APPT = '5a1c7d2e-0000-4000-8000-000000000001';
const TENANT = '9f3a1b2c-0000-4000-8000-0000000000aa';
const START = new Date(NOW.getTime() + 2 * HOUR);

function context(over: Partial<ReminderSendContext> = {}): ReminderSendContext {
  return {
    appointment: {
      id: APPT,
      start: START,
      status: 'SCHEDULED',
      deleted: false,
    },
    locationCountry: 'CO',
    locationTimeZone: 'America/Bogota',
    patientEmail: 'ana@example.com',
    settings: { enabled: true, leadHours: [48, 2] },
    ...over,
  };
}

describe('SendAppointmentReminder (DX-026)', () => {
  let repo: FakeReminderRepository;
  let createLink: { execute: jest.Mock };
  let outbound: { record: jest.Mock; settle: jest.Mock };
  let email: { enqueue: jest.Mock };
  let links: { forTenant: jest.Mock };
  let handler: SendAppointmentReminder;
  const payload = {
    appointmentId: APPT,
    leadHours: 2,
    start: START.toISOString(),
  };

  beforeEach(() => {
    repo = new FakeReminderRepository();
    createLink = {
      execute: jest.fn().mockResolvedValue({
        token: 'tok_123',
        appointment: {
          patientFirstName: 'Ana',
          start: START,
          end: new Date(START.getTime() + HOUR),
          providerName: 'Dra. Gómez',
          locationName: 'Sede Norte',
          locationAddress: 'Cra 15 # 93-60',
        },
      }),
    };
    outbound = {
      record: jest.fn().mockResolvedValue({ id: 'out-1' }),
      settle: jest.fn().mockResolvedValue(true),
    };
    email = {
      enqueue: jest.fn((input: { referenceId: string }) => {
        repo.queuedEmails.add(input.referenceId);
        return Promise.resolve({ id: 'mail-1' });
      }),
    };
    // SEC-033: el host de plataforma de la clínica, sin petición.
    links = {
      forTenant: jest.fn().mockResolvedValue('https://demo.dentalix.app'),
    };
    const clock: ReminderClock = { now: () => NOW };
    const tenantContext = { getTenantId: () => TENANT };
    handler = new SendAppointmentReminder(
      repo,
      createLink as never,
      outbound as never,
      email as never,
      links as never,
      clock,
      tenantContext as never,
    );
  });

  it('deja el email en el outbox con fecha en la zona de la sede, sede, profesional y enlace DX-005', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);

    expect(createLink.execute).toHaveBeenCalledWith({
      appointmentId: APPT,
      automatic: true,
    });
    expect(outbound.record).toHaveBeenCalledWith({
      channel: 'EMAIL',
      template: 'appointment-reminder',
      recipient: 'ana@example.com',
      appointmentId: APPT,
    });
    expect(email.enqueue).toHaveBeenCalledWith({
      tenantId: TENANT,
      to: 'ana@example.com',
      template: 'appointment-reminder',
      referenceId: 'out-1',
      vars: {
        patientName: 'Ana',
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:00 a. m.',
        locationName: 'Sede Norte',
        locationAddress: 'Cra 15 # 93-60',
        providerName: 'Dra. Gómez',
        confirmUrl: 'https://demo.dentalix.app/confirmar/tok_123',
      },
    });
    expect(outbound.settle).toHaveBeenCalledWith('out-1', { status: 'QUEUED' });
    expect(repo.reminders).toEqual([
      expect.objectContaining({
        status: 'SENT',
        outboundMessageId: 'out-1',
        sentAt: NOW,
      }),
    ]);
  });

  it('arma el enlace con el host de plataforma de la clínica del trabajo (SEC-033)', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);
    expect(links.forTenant).toHaveBeenCalledWith(TENANT);
  });

  it('sin host seguro para la clínica, el email sale sin enlace', async () => {
    repo.contexts.set(APPT, context());
    links.forTenant.mockResolvedValue(null);
    await handler.handle(payload);
    const [input] = email.enqueue.mock.calls[0] as [
      { vars: { confirmUrl: string | null } },
    ];
    expect(input.vars.confirmUrl).toBeNull();
  });

  it('ejecutarse dos veces no manda dos emails', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);
    await handler.handle(payload);
    expect(email.enqueue).toHaveBeenCalledTimes(1);
    expect(repo.reminders).toHaveLength(1);
  });

  it('un reintento tras caerse a mitad no vuelve a encolar si el email ya salió al outbox', async () => {
    repo.contexts.set(APPT, context());
    const claim = await repo.claim(APPT, 2, START);
    await repo.attachOutbound(claim.id, 'out-0');
    repo.queuedEmails.add('out-0');

    await handler.handle(payload);
    expect(email.enqueue).not.toHaveBeenCalled();
    expect(outbound.settle).toHaveBeenCalledWith('out-0', { status: 'QUEUED' });
    expect(repo.reminders[0]).toMatchObject({ status: 'SENT' });
  });

  it.each([
    ['sin email', context({ patientEmail: null }), 'NO_EMAIL'],
    [
      'cancelada',
      context({
        appointment: {
          id: APPT,
          start: START,
          status: 'CANCELLED',
          deleted: false,
        },
      }),
      'CANCELLED',
    ],
    [
      'reprogramada',
      context({
        appointment: {
          id: APPT,
          start: new Date(START.getTime() + 24 * HOUR),
          status: 'SCHEDULED',
          deleted: false,
        },
      }),
      'RESCHEDULED',
    ],
    [
      'sede desactivada',
      context({ settings: { enabled: false, leadHours: [2] } }),
      'DISABLED',
    ],
  ])(
    'omite (%s) y registra el motivo sin tocar el outbox',
    async (_, ctx, reason) => {
      repo.contexts.set(APPT, ctx);
      await handler.handle(payload);
      expect(email.enqueue).not.toHaveBeenCalled();
      expect(createLink.execute).not.toHaveBeenCalled();
      expect(repo.reminders).toEqual([
        expect.objectContaining({ status: 'SKIPPED', skipReason: reason }),
      ]);
    },
  );

  it('una cita que no es de la clínica del trabajo (o no existe) no hace nada', async () => {
    await handler.handle(payload);
    expect(createLink.execute).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
    expect(repo.reminders).toEqual([]);
  });

  it('rechaza un payload mal formado sin leer nada', async () => {
    await expect(
      handler.handle({ appointmentId: 'x', leadHours: 2, start: 'no' }),
    ).rejects.toThrow('payload');
  });
});
