import type { AttachOutboundMessage } from '../../notifications/outbound/application/outbound-messages.service';
import type { Prisma } from '@prisma/client';
import type { ReminderSendContext } from '../domain/ports/reminder-repository.port';
import { FakeReminderRepository } from './__fixtures__/fake-reminder.repository';
import { SendAppointmentReminder } from './send-appointment-reminder';
import type { ReminderClock } from './reminder-clock';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const APPT = '5a1c7d2e-0000-4000-8000-000000000001';
const TENANT = '9f3a1b2c-0000-4000-8000-0000000000aa';
const START = new Date(NOW.getTime() + 2 * HOUR);
const PATIENT = '5a1c7d2e-0000-4000-8000-000000000101';

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
    patientId: PATIENT,
    contact: {
      contactChannel: 'EMAIL',
      reminderOptOutAt: null,
      email: 'ana@example.com',
    },
    recipient: {
      firstName: 'Ana',
      birthDate: new Date('1990-05-01'),
      email: 'ana@example.com',
      emergencyContactName: null,
    },
    responsibles: [],
    settings: { enabled: true, leadHours: [48, 2] },
    cancellationPolicy: null,
    ...over,
  };
}

describe('SendAppointmentReminder (DX-026)', () => {
  let repo: FakeReminderRepository;
  let createLink: { execute: jest.Mock };
  let outbound: { record: jest.Mock; settle: jest.Mock };
  let email: { enqueue: jest.Mock };
  let links: { forTenant: jest.Mock };
  let optOutLinks: { issue: jest.Mock };
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
      record: jest.fn(
        async (_input: unknown, attach?: AttachOutboundMessage) => {
          await attach?.('out-1', {} as Prisma.TransactionClient);
          return { id: 'out-1' };
        },
      ),
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
    // DX-128: enlace de baja propio de cada email.
    optOutLinks = { issue: jest.fn().mockResolvedValue('opt_tok') };
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
      optOutLinks as never,
    );
  });

  it('deja el email en el outbox con fecha en la zona de la sede, sede, profesional y enlace DX-005', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);

    expect(createLink.execute).toHaveBeenCalledWith({
      appointmentId: APPT,
      automatic: true,
    });
    expect(outbound.record).toHaveBeenCalledWith(
      {
        channel: 'EMAIL',
        template: 'appointment-reminder',
        recipient: 'ana@example.com',
        recipientKind: 'PATIENT',
        appointmentId: APPT,
      },
      expect.any(Function),
    );
    expect(email.enqueue).toHaveBeenCalledWith({
      tenantId: TENANT,
      to: 'ana@example.com',
      template: 'appointment-reminder',
      referenceId: 'out-1',
      vars: {
        patientName: 'Ana',
        guardianName: null,
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:00 a. m.',
        locationName: 'Sede Norte',
        locationAddress: 'Cra 15 # 93-60',
        providerName: 'Dra. Gómez',
        confirmUrl: 'https://demo.dentalix.app/confirmar/tok_123',
        unsubscribeUrl: 'https://demo.dentalix.app/baja/opt_tok',
        cancellationPolicy: null,
      },
    });
    expect(optOutLinks.issue).toHaveBeenCalledWith(PATIENT);
    expect(outbound.settle).toHaveBeenCalledWith('out-1', { status: 'QUEUED' });
    expect(repo.reminders).toEqual([
      expect.objectContaining({
        status: 'SENT',
        outboundMessageId: 'out-1',
        sentAt: NOW,
      }),
    ]);
  });

  it('DX-291: lleva la política vigente de la sede ({politica_cancelacion}) y deja constancia de la versión enviada', async () => {
    repo.contexts.set(
      APPT,
      context({
        cancellationPolicy: {
          id: 'pol-v3',
          version: 3,
          noticeHours: 24,
          patientText: 'Avísanos con tiempo.',
          suggestedFee: 50000,
          currency: 'COP',
        },
      }),
    );
    await handler.handle(payload);

    const call = email.enqueue.mock.calls[0] as [
      { vars: { cancellationPolicy: unknown } },
    ];
    expect(call[0].vars.cancellationPolicy).toEqual({
      noticeHours: 24,
      text: 'Avísanos con tiempo.',
      feeLabel: expect.stringContaining('50.000') as unknown,
    });
    expect(repo.reminders[0]).toMatchObject({
      status: 'SENT',
      policyVersionId: 'pol-v3',
    });
    expect(repo.appointmentPolicyVersions.get(APPT)).toBe('pol-v3');
  });

  it('DX-291: sin política en la sede no hay bloque ni versión', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);
    expect(repo.reminders[0].policyVersionId).toBeUndefined();
    expect(repo.appointmentPolicyVersions.size).toBe(0);
  });

  const mother = {
    id: 'resp-1',
    name: 'María José Pérez',
    email: 'maria@example.com',
    isPayer: true,
    receivesNotices: true,
    optedOut: false,
  };
  const minorWithoutEmail = {
    firstName: 'Ana',
    birthDate: new Date('2016-02-01'),
    email: null,
    emergencyContactName: null,
  };

  it('un menor sin email con responsable que recibe avisos: sale al email del responsable y queda «enviado al responsable» (DX-203)', async () => {
    repo.contexts.set(
      APPT,
      context({
        contact: {
          contactChannel: 'EMAIL',
          reminderOptOutAt: null,
          email: null,
        },
        recipient: minorWithoutEmail,
        responsibles: [mother],
      }),
    );
    await handler.handle(payload);
    expect(outbound.record).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'maria@example.com',
        recipientKind: 'RESPONSIBLE',
      }),
      expect.any(Function),
    );
    const [input] = email.enqueue.mock.calls[0] as [
      {
        to: string;
        vars: { patientName: string; guardianName: string | null };
      },
    ];
    expect(input.to).toBe('maria@example.com');
    // Saluda al responsable y nombra al paciente.
    expect(input.vars.patientName).toBe('Ana');
    expect(input.vars.guardianName).toBe('María');
    // La baja del email es la del PACIENTE de la cita.
    expect(optOutLinks.issue).toHaveBeenCalledWith(PATIENT);
    expect(repo.reminders[0]).toMatchObject({ status: 'SENT' });
  });

  it('un menor sin email cuyo responsable no recibe avisos (o se dio de baja): NO_EMAIL', async () => {
    for (const responsible of [
      { ...mother, receivesNotices: false },
      { ...mother, optedOut: true },
    ]) {
      repo.reminders.length = 0;
      repo.contexts.set(
        APPT,
        context({
          contact: {
            contactChannel: 'EMAIL',
            reminderOptOutAt: null,
            email: null,
          },
          recipient: minorWithoutEmail,
          responsibles: [responsible],
        }),
      );
      await handler.handle(payload);
      expect(repo.reminders[0]).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'NO_EMAIL',
      });
    }
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('la baja del propio paciente gana aunque tenga responsable (DX-128)', async () => {
    repo.contexts.set(
      APPT,
      context({
        contact: {
          contactChannel: 'EMAIL',
          reminderOptOutAt: new Date(NOW.getTime() - 60_000),
          email: null,
        },
        recipient: minorWithoutEmail,
        responsibles: [mother],
      }),
    );
    await handler.handle(payload);
    expect(repo.reminders[0]).toMatchObject({ skipReason: 'OPTED_OUT' });
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('un menor con email y responsable sin email: va al email de la ficha saludando al responsable (DX-128)', async () => {
    repo.contexts.set(
      APPT,
      context({
        recipient: { ...minorWithoutEmail, email: 'familia@example.com' },
        contact: {
          contactChannel: 'EMAIL',
          reminderOptOutAt: null,
          email: 'familia@example.com',
        },
        responsibles: [{ ...mother, email: null }],
      }),
    );
    await handler.handle(payload);
    const [input] = email.enqueue.mock.calls[0] as [
      { to: string; vars: { guardianName: string | null } },
    ];
    expect(input.to).toBe('familia@example.com');
    expect(input.vars.guardianName).toBe('María');
    expect(outbound.record).toHaveBeenCalledWith(
      expect.objectContaining({ recipientKind: 'PATIENT' }),
      expect.any(Function),
    );
  });

  it('arma el enlace con el host de plataforma de la clínica del trabajo (SEC-033)', async () => {
    repo.contexts.set(APPT, context());
    await handler.handle(payload);
    expect(links.forTenant).toHaveBeenCalledWith(TENANT);
  });

  it('sin host seguro para la clínica, el email sale sin enlaces', async () => {
    repo.contexts.set(APPT, context());
    links.forTenant.mockResolvedValue(null);
    await handler.handle(payload);
    const [input] = email.enqueue.mock.calls[0] as [
      { vars: { confirmUrl: string | null; unsubscribeUrl: string | null } },
    ];
    expect(input.vars.confirmUrl).toBeNull();
    expect(input.vars.unsubscribeUrl).toBeNull();
    expect(optOutLinks.issue).not.toHaveBeenCalled();
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

  it.each([1, 5])(
    'DX-160: intento %i fallido conserva SENDING hasta agotar los cinco',
    async (attempt) => {
      repo.contexts.set(APPT, context());
      const error = Object.assign(new Error('private ana@example.com'), {
        code: 'ECONNRESET',
      });
      email.enqueue.mockRejectedValueOnce(error);
      await expect(
        handler.handle(payload, {
          jobId: 'job-1',
          attempt,
          maxAttempts: 5,
          tenantId: TENANT,
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(error);
      expect(repo.reminders[0]).toMatchObject(
        attempt === 5
          ? {
              status: 'FAILED',
              failureReason: 'Error ECONNRESET',
              outboundMessageId: 'out-1',
            }
          : { status: 'SENDING' },
      );
    },
  );

  it('DX-160 fix I2: último fallo anterior al claim registra FAILED sin destinatario', async () => {
    repo.contexts.set(APPT, context());
    const error = Object.assign(new Error('private ana@example.com'), {
      code: 'ECONNRESET',
    });
    jest.spyOn(repo, 'loadSendContext').mockRejectedValueOnce(error);
    await expect(
      handler.handle(payload, {
        jobId: 'job-1',
        attempt: 5,
        maxAttempts: 5,
        tenantId: TENANT,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(error);
    expect(repo.reminders).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        failureReason: 'Error ECONNRESET',
        outboundMessageId: null,
      }),
    ]);
    expect(outbound.record).not.toHaveBeenCalled();
  });

  it('DX-160: fallo al cerrar después del outbox se recupera SENT en el último intento', async () => {
    repo.contexts.set(APPT, context());
    outbound.settle.mockRejectedValueOnce(new Error('transient'));
    await expect(
      handler.handle(payload, {
        jobId: 'job-1',
        attempt: 5,
        maxAttempts: 5,
        tenantId: TENANT,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('transient');
    expect(repo.reminders[0]).toMatchObject({ status: 'SENT', sentAt: NOW });
    expect(email.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'sin email',
      context({
        contact: {
          contactChannel: 'EMAIL',
          reminderOptOutAt: null,
          email: null,
        },
      }),
      'NO_EMAIL',
    ],
    // DX-128: se dio de baja (o cambió de canal) después de encolarse.
    [
      'con baja',
      context({
        contact: {
          contactChannel: 'EMAIL',
          reminderOptOutAt: new Date(NOW.getTime() - 60_000),
          email: 'ana@example.com',
        },
      }),
      'OPTED_OUT',
    ],
    [
      'canal NONE',
      context({
        contact: {
          contactChannel: 'NONE',
          reminderOptOutAt: null,
          email: 'ana@example.com',
        },
      }),
      'CHANNEL_NONE',
    ],
    [
      'canal WHATSAPP',
      context({
        contact: {
          contactChannel: 'WHATSAPP',
          reminderOptOutAt: null,
          email: 'ana@example.com',
        },
      }),
      'CHANNEL_WHATSAPP',
    ],
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
      expect(optOutLinks.issue).not.toHaveBeenCalled();
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
