import { OutboundMessages } from '../src/modules/notifications/outbound/application/outbound-messages.service';
import { PrismaAppointmentConfirmationRepository } from '../src/modules/appointment-confirmations/infrastructure/repositories/prisma-appointment-confirmation.repository';
import type { RespondOutcome } from '../src/modules/appointment-confirmations/domain/ports/appointment-confirmation-repository.port';
import { GetAppointmentRemindersUseCase } from '../src/modules/reminders/application/use-cases/get-appointment-reminders.use-case';
import {
  REMINDER_REPOSITORY,
  type ReminderRepository,
} from '../src/modules/reminders/domain/ports/reminder-repository.port';
import { ConflictException } from '@nestjs/common';
import { CreateConfirmationLinkUseCase } from '../src/modules/appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import { RespondConfirmationUseCase } from '../src/modules/appointment-confirmations/application/use-cases/respond-confirmation.use-case';
import {
  APPOINTMENT_CONFIRMATION_REPOSITORY,
  type AppointmentConfirmationRepository,
} from '../src/modules/appointment-confirmations/domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { SendAppointmentReminder } from '../src/modules/reminders/application/send-appointment-reminder';
import { hashConfirmationToken } from '../src/modules/appointment-confirmations/application/confirmation-token';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppointmentStatus, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { ReminderClock } from '../src/modules/reminders/application/reminder-clock';
import {
  PLAN_REMINDERS_SCHEDULE,
  SEND_REMINDER_JOB,
} from '../src/modules/reminders/application/plan-reminders';
import { OptOutByMessageUseCase } from '../src/modules/reminders/application/use-cases/reminder-opt-out.use-cases';
import { CapturingMailer } from './support/capture-mailer';
import { waitFor } from './support/wait-for';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  locationData,
  type RegionalFixture,
} from './support/location-fixtures';
import { regionalFormat } from '../src/shared/format/regional-format';
import { startsAtLabel } from '../src/modules/reminders/domain/starts-at-label';
import { PreviewReminderEmailUseCase } from '../src/modules/cancellation-policies/application/use-cases/cancellation-policy.use-cases';

// DX-026, capa de BD con la app REAL (AppModule) y DOS workers (dos apps, dos
// pools), como dos réplicas: el barrido programado de DX-085 encola, el
// handler deja el email en email_outbox (DX-088) con el enlace de DX-005.
// El tiempo avanza con un reloj de prueba (ReminderClock); los trabajos que
// esperan a su hora se adelantan en `jobs.runAt`, sin dormir.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx026-int-a', 'dx026-int-b'];
const HOUR = 3_600_000;
const MIN = 60_000;

class TestClock extends ReminderClock {
  current = new Date();
  now(): Date {
    return new Date(this.current);
  }
}

interface Clinic {
  tenantId: string;
  locationId: string;
  providerId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: `Clínica ${subdomain}`, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Centro',
      address: 'Calle 1 # 2-3',
    }),
  });
  const provider = await owner.user.create({
    data: {
      email: `doc@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Laura Gómez',
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: provider.id, role: 'DENTIST' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    providerId: provider.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const where = { tenantId: { in: ids } };
  await owner.appointmentReminder.deleteMany({ where });
  await owner.outboundMessage.deleteMany({ where });
  await owner.emailOutbox.deleteMany({ where });
  await owner.appointmentConfirmation.deleteMany({ where });
  await owner.appointment.deleteMany({ where });
  // DX-291: la versión de la política que llevó el recordatorio.
  await owner.cancellationPolicyVersion.deleteMany({ where });
  await owner.locationReminderSettings.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.clinicMembership.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.job.deleteMany({ where });
  await owner.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `doc@${s}.test`) } },
  });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-026 · recordatorios automáticos por email (int)', () => {
  const clock = new TestClock();
  const mailer = new CapturingMailer();
  let a: TestingModule;
  let b: TestingModule;
  let clinicA: Clinic;
  let clinicB: Clinic;

  async function app(): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ReminderClock)
      .useValue(clock)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    await moduleRef.init();
    return moduleRef;
  }

  /** Los dos workers a la vez hasta que no quede nada vencido. */
  const drainBoth = () =>
    Promise.all([a.get(JobWorker).drain(), b.get(JobWorker).drain()]);

  /** Un tick del barrido programado, disputado por los dos workers. */
  async function sweep(): Promise<void> {
    await Promise.all([a.get(JobWorker).runOnce(), b.get(JobWorker).runOnce()]);
    await owner.jobSchedule.update({
      where: { name: PLAN_REMINDERS_SCHEDULE },
      data: { nextRunAt: new Date(Date.now() - MIN) },
    });
    await drainBoth();
  }

  /** Adelanta los envíos de la clínica que esperan a su hora y los ejecuta. */
  async function releaseDue(tenantId: string): Promise<void> {
    await owner.job.updateMany({
      where: { tenantId, name: SEND_REMINDER_JOB, state: 'PENDING' },
      data: { runAt: new Date(Date.now() - MIN) },
    });
    await drainBoth();
  }

  async function patient(
    clinic: Clinic,
    email: string | null,
    extra: Partial<Prisma.PatientUncheckedCreateInput> = {},
  ): Promise<string> {
    const p = await owner.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Carolina',
        lastName: 'Duque',
        email,
        ...extra,
      },
    });
    return p.id;
  }

  async function appointment(
    clinic: Clinic,
    patientId: string,
    start: Date,
    status: AppointmentStatus = 'SCHEDULED',
  ): Promise<string> {
    const appt = await owner.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: clinic.locationId,
        patientId,
        providerId: clinic.providerId,
        start,
        end: new Date(start.getTime() + 30 * MIN),
        status,
        reason: 'Dolor en la muela 36',
      },
    });
    return appt.id;
  }

  async function configure(clinic: Clinic, leadHours: number[]) {
    await owner.locationReminderSettings.upsert({
      where: {
        tenantId_locationId: {
          tenantId: clinic.tenantId,
          locationId: clinic.locationId,
        },
      },
      create: {
        tenantId: clinic.tenantId,
        locationId: clinic.locationId,
        enabled: true,
        leadHours,
      },
      update: { enabled: true, leadHours },
    });
  }

  const reminderEmails = (tenantId: string) =>
    owner.emailOutbox.count({
      where: { tenantId, template: 'APPOINTMENT_REMINDER' },
    });

  const records = (appointmentId: string) =>
    owner.appointmentReminder.findMany({
      where: { appointmentId },
      orderBy: [{ appointmentStart: 'asc' }, { leadHours: 'desc' }],
    });

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await cleanup();
    clinicA = await seedClinic(SUBDOMAINS[0]);
    clinicB = await seedClinic(SUBDOMAINS[1]);
    a = await app();
    b = await app();
  });

  afterAll(async () => {
    await cleanup();
    await a?.close();
    await b?.close();
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    clock.current = new Date();
    mailer.clear();
    const where = { tenantId: { in: [clinicA.tenantId, clinicB.tenantId] } };
    await owner.appointmentReminder.deleteMany({ where });
    await owner.outboundMessage.deleteMany({ where });
    await owner.emailOutbox.deleteMany({ where });
    await owner.appointmentConfirmation.deleteMany({ where });
    await owner.appointment.deleteMany({ where });
    await owner.job.deleteMany({ where });
    await owner.locationReminderSettings.deleteMany({ where });
  });

  it('con [48, 2] una cita recibe exactamente 2 emails aunque el barrido corra varias veces y en dos workers', async () => {
    await configure(clinicA, [48, 2]);
    const email = 'carolina.duque@example.com';
    const start = new Date(Date.now() + 48 * HOUR + 5 * MIN);
    const id = await appointment(clinicA, await patient(clinicA, email), start);

    // 48 h antes: tres ticks seguidos, cada uno disputado por los dos workers.
    await sweep();
    await sweep();
    await sweep();
    await releaseDue(clinicA.tenantId);
    await sweep();
    await releaseDue(clinicA.tenantId);

    // 2 h antes.
    clock.current = new Date(start.getTime() - 2 * HOUR - MIN);
    await sweep();
    await sweep();
    await releaseDue(clinicA.tenantId);
    await sweep();
    await releaseDue(clinicA.tenantId);

    expect(await reminderEmails(clinicA.tenantId)).toBe(2);
    expect(
      await owner.job.count({
        where: { tenantId: clinicA.tenantId, name: SEND_REMINDER_JOB },
      }),
    ).toBe(2);
    const rows = await records(id);
    expect(rows.map((r) => [r.leadHours, r.status])).toEqual([
      [48, 'SENT'],
      [2, 'SENT'],
    ]);
    // El registro guarda el id del mensaje (DX-085), nunca el cuerpo.
    const outbound = await owner.outboundMessage.findMany({
      where: { appointmentId: id },
    });
    expect(outbound).toHaveLength(2);
    expect(outbound.every((m) => m.status === 'QUEUED')).toBe(true);
    expect(outbound.map((m) => m.recipientMasked)).toEqual([
      'ca***@example.com',
      'ca***@example.com',
    ]);
    expect(rows.map((r) => r.outboundMessageId).sort()).toEqual(
      outbound.map((m) => m.id).sort(),
    );

    // El email: fecha y hora en la zona de la sede, sede, profesional
    // y el enlace de confirmación de DX-005; nada clínico.
    await waitFor(() => mailer.sent.length === 2, 'el despachador entrega 2');
    const text = mailer.sent[1].text;
    expect(mailer.sent[1].subject).toBe(
      `Recordatorio de tu cita en Clínica ${SUBDOMAINS[0]}`,
    );
    // Con el formato y el reloj explícitos de la sede (DX-350).
    expect(text).toContain(
      `Fecha y hora: ${startsAtLabel(
        start,
        REGIONAL_BOGOTA_FIXTURE.timeZone,
        regionalFormat(REGIONAL_BOGOTA_FIXTURE),
      )} (hora de la sede)`,
    );
    expect(text).toContain('Sede: Sede Centro (Calle 1 # 2-3)');
    expect(text).toContain('Profesional: Dra. Laura Gómez');
    // Sin petición: el host de plataforma de la clínica (SEC-033), con el
    // primer TENANT_BASE_DOMAINS de .env.test y sin puerto.
    expect(text).toMatch(
      new RegExp(
        `http://${SUBDOMAINS[0]}\\.dentalix\\.app/confirmar/[A-Za-z0-9_-]{43}`,
      ),
    );
    expect(text).not.toContain('muela');
    // DX-128: cada email lleva su propio enlace de baja, en el mismo host.
    const optOut = new RegExp(
      `http://${SUBDOMAINS[0]}\\.dentalix\\.app/baja/([A-Za-z0-9_-]{43})`,
    );
    expect(mailer.sent[0].text).toMatch(optOut);
    expect(text).toMatch(optOut);
    expect(optOut.exec(text)?.[1]).not.toBe(
      optOut.exec(mailer.sent[0].text)?.[1],
    );
    expect(
      await owner.reminderOptOutLink.count({
        where: { tenantId: clinicA.tenantId },
      }),
    ).toBe(2);
  });

  it('DX-160: manual y recordatorios de 48h/2h siguen vivos, y responder cierra todos', async () => {
    await configure(clinicA, [48, 2]);
    const start = new Date(Date.now() + 48 * HOUR + 5 * MIN);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const manual = await a
      .get(TenantContextService)
      .run(clinicA.tenantId, () =>
        a.get(CreateConfirmationLinkUseCase).execute({ appointmentId: id }),
      );
    await sweep();
    await releaseDue(clinicA.tenantId);
    clock.current = new Date(start.getTime() - 2 * HOUR - MIN);
    await sweep();
    await releaseDue(clinicA.tenantId);
    const links = await owner.appointmentConfirmation.findMany({
      where: { appointmentId: id },
    });
    expect(links).toHaveLength(3);
    expect(
      links.every(
        (link) => link.revokedAt === null && link.respondedAt === null,
      ),
    ).toBe(true);
    expect(
      links.every((link) => link.expiresAt.getTime() === start.getTime()),
    ).toBe(true);
    expect(
      links.find(
        (link) => link.tokenHash === hashConfirmationToken(manual.token),
      ),
    ).toBeDefined();
    await a
      .get(TenantContextService)
      .run(clinicA.tenantId, () =>
        a.get(RespondConfirmationUseCase).execute(manual.token, 'confirm'),
      );
    const closed = await owner.appointmentConfirmation.findMany({
      where: { appointmentId: id },
    });
    expect(
      closed.every(
        (link) => link.response === 'CONFIRM' && link.respondedAt !== null,
      ),
    ).toBe(true);
  });

  it('DX-160: fallo enqueue no revoca enlaces previos', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const tenant = a.get(TenantContextService);
    const manual = await tenant.run(clinicA.tenantId, () =>
      a.get(CreateConfirmationLinkUseCase).execute({ appointmentId: id }),
    );
    const enqueue = jest
      .spyOn(a.get(EmailOutbox), 'enqueue')
      .mockRejectedValueOnce(new Error('private patient email'));
    try {
      await expect(
        tenant.run(clinicA.tenantId, () =>
          a.get(SendAppointmentReminder).handle({
            appointmentId: id,
            leadHours: 2,
            start: start.toISOString(),
          }),
        ),
      ).rejects.toThrow('private patient email');
      const links = await owner.appointmentConfirmation.findMany({
        where: { appointmentId: id },
      });
      expect(links).toHaveLength(2);
      expect(links.every((link) => link.revokedAt === null)).toBe(true);
      await expect(
        tenant.run(clinicA.tenantId, () =>
          a.get(RespondConfirmationUseCase).execute(manual.token, 'confirm'),
        ),
      ).resolves.toMatchObject({ status: 'RESPONDED' });
    } finally {
      enqueue.mockRestore();
    }
  });

  it.each([
    ['SCHEDULED', 'confirm', 'CONFIRM'],
    ['SCHEDULED', 'cancel', 'CANCEL'],
    ['SCHEDULED', 'call_me', 'CALL_ME'],
    ['CONFIRMED', 'confirm', 'CONFIRM'],
    ['CONFIRMED', 'cancel', 'CANCEL'],
    ['CONFIRMED', 'call_me', 'CALL_ME'],
  ] as const)(
    'DX-160: dos tokens distintos %s/%s solo aceptan una respuesta',
    async (status, action, response) => {
      const start = new Date(Date.now() + 2 * HOUR);
      const id = await appointment(
        clinicA,
        await patient(clinicA, 'ana@example.com'),
        start,
        status,
      );
      const tenant = a.get(TenantContextService);
      const create = a.get(CreateConfirmationLinkUseCase);
      const first = await tenant.run(clinicA.tenantId, () =>
        create.execute({ appointmentId: id }),
      );
      const second = await tenant.run(clinicA.tenantId, () =>
        create.execute({ appointmentId: id, automatic: true }),
      );
      // La barrera deja que ambos lean el estado antes de disputar la escritura.
      const repo = a.get<AppointmentConfirmationRepository>(
        APPOINTMENT_CONFIRMATION_REPOSITORY,
      );
      const respond = repo.respond.bind(repo);
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = jest
        .spyOn(repo, 'respond')
        .mockImplementation(async (input) => {
          if (++arrived === 2) release();
          await barrier;
          return respond(input);
        });
      try {
        const result = await Promise.allSettled(
          [first.token, second.token].map((token) =>
            tenant.run(clinicA.tenantId, () =>
              a.get(RespondConfirmationUseCase).execute(token, action),
            ),
          ),
        );
        expect(
          result.filter((item) => item.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = result.filter((item) => item.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);
        const closed = await owner.appointmentConfirmation.findMany({
          where: { appointmentId: id },
        });
        expect(
          closed.every(
            (link) => link.response === response && link.respondedAt !== null,
          ),
        ).toBe(true);
      } finally {
        gate.mockRestore();
      }
    },
  );

  it('DX-160: worker agota intento y cierra reminder/outbound con motivo sin PII', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const error = Object.assign(new Error('ana@example.com private'), {
      code: 'ECONNRESET',
    });
    const spies = [a, b].map((app) =>
      jest.spyOn(app.get(EmailOutbox), 'enqueue').mockRejectedValue(error),
    );
    try {
      await a
        .get(JobQueue)
        .enqueue(
          SEND_REMINDER_JOB,
          { appointmentId: id, leadHours: 2, start: start.toISOString() },
          { tenantId: clinicA.tenantId, maxAttempts: 2 },
        );
      await drainBoth();
      expect(
        await owner.job.findFirstOrThrow({
          where: { tenantId: clinicA.tenantId, name: SEND_REMINDER_JOB },
        }),
      ).toMatchObject({
        state: 'PENDING',
        attempts: 1,
        lastError: 'Error ECONNRESET',
      });
      expect((await records(id))[0]).toMatchObject({
        status: 'SENDING',
        failureReason: null,
      });
      await releaseDue(clinicA.tenantId);
      expect(
        await owner.job.findFirstOrThrow({
          where: { tenantId: clinicA.tenantId, name: SEND_REMINDER_JOB },
        }),
      ).toMatchObject({
        state: 'FAILED',
        attempts: 2,
        lastError: 'Error ECONNRESET',
      });
      expect((await records(id))[0]).toMatchObject({
        status: 'FAILED',
        failureReason: 'Error ECONNRESET',
        sentAt: null,
      });
      expect(
        await owner.outboundMessage.findFirstOrThrow({
          where: { appointmentId: id },
        }),
      ).toMatchObject({ status: 'FAILED', lastError: 'Error ECONNRESET' });
      expect(await reminderEmails(clinicA.tenantId)).toBe(0);
      await a.get(TenantContextService).run(clinicA.tenantId, () =>
        a.get(SendAppointmentReminder).handle({
          appointmentId: id,
          leadHours: 2,
          start: start.toISOString(),
        }),
      );
      expect(await records(id)).toHaveLength(1);
      expect(
        await owner.outboundMessage.findFirstOrThrow({
          where: { appointmentId: id },
        }),
      ).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastError: 'Error ECONNRESET',
      });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('DX-160: fallo de cierre tras encolar recupera SENT desde el outbox real', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const repo = a.get<ReminderRepository>(REMINDER_REPOSITORY);
    const markSent = jest
      .spyOn(repo, 'markSent')
      .mockRejectedValueOnce(new Error('temporary'));
    try {
      await expect(
        a.get(TenantContextService).run(clinicA.tenantId, () =>
          a.get(SendAppointmentReminder).handle(
            { appointmentId: id, leadHours: 2, start: start.toISOString() },
            {
              jobId: 'last-job',
              attempt: 5,
              maxAttempts: 5,
              tenantId: clinicA.tenantId,
              signal: new AbortController().signal,
            },
          ),
        ),
      ).rejects.toThrow('temporary');
      expect(await records(id)).toEqual([
        expect.objectContaining({
          status: 'SENT',
          failureReason: null,
          sentAt: expect.any(Date) as Date,
        }),
      ]);
      expect(await reminderEmails(clinicA.tenantId)).toBe(1);
      const outbound = await owner.outboundMessage.findFirstOrThrow({
        where: { appointmentId: id },
      });
      expect(outbound.status).not.toBe('FAILED');
      await a.get(TenantContextService).run(clinicA.tenantId, () =>
        a.get(SendAppointmentReminder).handle({
          appointmentId: id,
          leadHours: 2,
          start: start.toISOString(),
        }),
      );
      expect(await reminderEmails(clinicA.tenantId)).toBe(1);
    } finally {
      markSent.mockRestore();
    }
  });

  it('DX-160: escritura rechaza token ya caducado aunque lectura haya sido pendiente', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const tenant = a.get(TenantContextService);
    await tenant.run(clinicA.tenantId, () =>
      a.get(CreateConfirmationLinkUseCase).execute({ appointmentId: id }),
    );
    const link = await owner.appointmentConfirmation.findFirstOrThrow({
      where: { appointmentId: id },
    });
    const repo = a.get<AppointmentConfirmationRepository>(
      APPOINTMENT_CONFIRMATION_REPOSITORY,
    );
    const outcome = await tenant.run(clinicA.tenantId, () =>
      repo.respond({
        confirmationId: link.id,
        appointmentId: id,
        response: 'CONFIRM',
        now: start,
        expectedStart: start,
        expectedStatus: 'SCHEDULED',
      }),
    );
    expect(outcome).toBe('STALE');
    expect(
      await owner.appointment.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'SCHEDULED' });
    expect(
      await owner.appointmentConfirmation.findUniqueOrThrow({
        where: { id: link.id },
      }),
    ).toMatchObject({ respondedAt: null });
  });

  it('DX-160 fix I1: caduca mientras espera el lock de cita y no responde', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const tenant = a.get(TenantContextService);
    await tenant.run(clinicA.tenantId, () =>
      a.get(CreateConfirmationLinkUseCase).execute({ appointmentId: id }),
    );
    const link = await owner.appointmentConfirmation.findFirstOrThrow({
      where: { appointmentId: id },
    });
    let unlock!: () => void;
    let locked!: () => void;
    let connected!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const backend = new Promise<number>((resolve) => {
      connected = resolve;
    });
    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "appointments" WHERE "id" = ${id}::uuid FOR UPDATE`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await held;
    // Solo observamos el PID: la transacción y todas las consultas son PostgreSQL real.
    const prisma = a.get(PrismaService);
    const repository = new PrismaAppointmentConfirmationRepository(
      {
        runWithTenant: (
          fn: (tx: Prisma.TransactionClient) => Promise<RespondOutcome>,
        ) =>
          prisma.runWithTenant(clinicA.tenantId, async (tx) => {
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            connected(row.pid);
            return fn(tx);
          }),
      } as unknown as PrismaService,
      tenant,
    );
    const response = repository.respond({
      confirmationId: link.id,
      appointmentId: id,
      response: 'CONFIRM',
      now: new Date(start.getTime() - 1000),
      expectedStart: start,
      expectedStatus: 'SCHEDULED',
    });
    let currentTime: jest.SpyInstance | undefined;
    try {
      const pid = await backend;
      let waiting = false;
      // Barrera observable de BD, sin sleeps ni depender de cuánto tarda la red.
      for (let attempt = 0; attempt < 100; attempt++) {
        const [activity] = await owner.$queryRaw<
          { waiting: boolean }[]
        >`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`;
        if (activity?.waiting) {
          waiting = true;
          break;
        }
      }
      expect(waiting).toBe(true);
      currentTime = jest
        .spyOn(Date, 'now')
        .mockReturnValue(start.getTime() + 1);
      unlock();
      await holder;
      expect(await response).toBe('STALE');
      expect(
        await owner.appointment.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'SCHEDULED' });
      expect(
        await owner.appointmentConfirmation.findUniqueOrThrow({
          where: { id: link.id },
        }),
      ).toMatchObject({ respondedAt: null, response: null });
    } finally {
      unlock();
      await holder;
      await response;
      currentTime?.mockRestore();
    }
  });

  it.each(['loadSendContext', 'attachOutbound'] as const)(
    'DX-160 fix I2: último fallo en %s deja FAILED sin mensajes huérfanos',
    async (boundary) => {
      await configure(clinicA, [2]);
      const start = new Date(Date.now() + 2 * HOUR);
      const id = await appointment(
        clinicA,
        await patient(clinicA, 'ana@example.com'),
        start,
      );
      const error = Object.assign(new Error('private ana@example.com'), {
        code: 'ECONNRESET',
      });
      const failures = [a, b].map((app) =>
        jest
          .spyOn(app.get<ReminderRepository>(REMINDER_REPOSITORY), boundary)
          .mockRejectedValue(error),
      );
      try {
        await a
          .get(JobQueue)
          .enqueue(
            SEND_REMINDER_JOB,
            { appointmentId: id, leadHours: 2, start: start.toISOString() },
            { tenantId: clinicA.tenantId, maxAttempts: 1 },
          );
        await drainBoth();
        expect(
          await owner.job.findFirstOrThrow({
            where: { tenantId: clinicA.tenantId, name: SEND_REMINDER_JOB },
          }),
        ).toMatchObject({ state: 'FAILED', lastError: 'Error ECONNRESET' });
        expect(await records(id)).toEqual([
          expect.objectContaining({
            status: 'FAILED',
            failureReason: 'Error ECONNRESET',
            sentAt: null,
          }),
        ]);
        const outbound = await owner.outboundMessage.findMany({
          where: { appointmentId: id },
        });
        expect(outbound).toHaveLength(0);
        const view = await a
          .get(TenantContextService)
          .run(clinicA.tenantId, () =>
            a.get(GetAppointmentRemindersUseCase).execute(id),
          );
        expect(view.items.find((item) => item.leadHours === 2)).toMatchObject({
          state: 'FAILED',
          failureReason: 'Error ECONNRESET',
        });
        expect(await reminderEmails(clinicA.tenantId)).toBe(0);
      } finally {
        failures.forEach((failure) => failure.mockRestore());
      }
    },
  );

  it.each([false, true])(
    'DX-160 fix2: attach falla y el retry termina con éxito=%s sin mensajes huérfanos',
    async (retrySucceeds) => {
      await configure(clinicA, [2]);
      const start = new Date(Date.now() + 2 * HOUR);
      const id = await appointment(
        clinicA,
        await patient(clinicA, 'ana@example.com'),
        start,
      );
      const error = Object.assign(new Error('private ana@example.com'), {
        code: 'ECONNRESET',
      });
      const failures = [a, b].map((app) => {
        const attach = jest.spyOn(
          app.get<ReminderRepository>(REMINDER_REPOSITORY),
          'attachOutbound',
        );
        return retrySucceeds
          ? attach.mockRejectedValueOnce(error)
          : attach.mockRejectedValue(error);
      });
      try {
        await a
          .get(JobQueue)
          .enqueue(
            SEND_REMINDER_JOB,
            { appointmentId: id, leadHours: 2, start: start.toISOString() },
            { tenantId: clinicA.tenantId, maxAttempts: 2 },
          );
        // Un worker fijo permite fallar una única vez sin depender del ganador.
        await a.get(JobWorker).drain();
        expect((await records(id))[0]).toMatchObject({
          status: 'SENDING',
          outboundMessageId: null,
        });
        expect(
          await owner.outboundMessage.findMany({
            where: { appointmentId: id },
          }),
        ).toEqual([]);
        expect(await reminderEmails(clinicA.tenantId)).toBe(0);
        await owner.job.updateMany({
          where: {
            tenantId: clinicA.tenantId,
            name: SEND_REMINDER_JOB,
            state: 'PENDING',
          },
          data: { runAt: new Date(Date.now() - MIN) },
        });
        await a.get(JobWorker).drain();
        const rows = await records(id);
        const messages = await owner.outboundMessage.findMany({
          where: { appointmentId: id },
        });
        expect(rows).toHaveLength(1);
        if (retrySucceeds) {
          expect(rows[0]).toMatchObject({
            status: 'SENT',
            failureReason: null,
          });
          expect(messages).toHaveLength(1);
          expect(messages[0].status).not.toBe('FAILED');
          expect(rows[0].outboundMessageId).toBe(messages[0].id);
          expect(await reminderEmails(clinicA.tenantId)).toBe(1);
        } else {
          expect(rows[0]).toMatchObject({
            status: 'FAILED',
            failureReason: 'Error ECONNRESET',
            outboundMessageId: null,
          });
          expect(messages).toEqual([]);
          expect(await reminderEmails(clinicA.tenantId)).toBe(0);
        }
      } finally {
        failures.forEach((failure) => failure.mockRestore());
      }
    },
  );

  it('DX-160 fix2: asociar recordatorio de otro tenant revierte la creación del mensaje', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const idA = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const idB = await appointment(
      clinicB,
      await patient(clinicB, 'bea@example.com'),
      start,
    );
    const tenant = a.get(TenantContextService);
    const repo = a.get<ReminderRepository>(REMINDER_REPOSITORY);
    const claimB = await tenant.run(clinicB.tenantId, () =>
      repo.claim(idB, 2, start),
    );
    const outbound = a.get(OutboundMessages);
    await expect(
      tenant.run(clinicA.tenantId, () =>
        outbound.record(
          {
            channel: 'EMAIL',
            template: 'appointment-reminder',
            recipient: 'ana@example.com',
            appointmentId: idA,
          },
          (id: string, tx: Prisma.TransactionClient) =>
            repo.attachOutbound(claimB.id, id, tx),
        ),
      ),
    ).rejects.toThrow('ReminderOutboundNotAttachable');
    expect(
      await owner.outboundMessage.count({
        where: { appointmentId: { in: [idA, idB] } },
      }),
    ).toBe(0);
    expect((await records(idB))[0]).toMatchObject({
      status: 'SENDING',
      outboundMessageId: null,
    });
  });

  it.each(['SENT', 'SKIPPED', 'FAILED'] as const)(
    'DX-160 fix2: asociar a estado final %s revierte el nuevo outbound y conserva el estado',
    async (status) => {
      const start = new Date(Date.now() + 2 * HOUR);
      const id = await appointment(
        clinicA,
        await patient(clinicA, 'ana@example.com'),
        start,
      );
      const tenant = a.get(TenantContextService);
      const repo = a.get<ReminderRepository>(REMINDER_REPOSITORY);
      const outbound = a.get(OutboundMessages);
      const existing =
        status === 'SENT'
          ? await tenant.run(clinicA.tenantId, () =>
              outbound.record({
                channel: 'EMAIL',
                template: 'appointment-reminder',
                recipient: 'ana@example.com',
                appointmentId: id,
              }),
            )
          : null;
      const reminder = await owner.appointmentReminder.create({
        data: {
          tenantId: clinicA.tenantId,
          appointmentId: id,
          leadHours: 2,
          appointmentStart: start,
          status,
          outboundMessageId: existing?.id,
          sentAt: status === 'SENT' ? new Date() : null,
          skipReason: status === 'SKIPPED' ? 'DISABLED' : null,
          failureReason: status === 'FAILED' ? 'Error ECONNRESET' : null,
        },
      });
      await expect(
        tenant.run(clinicA.tenantId, () =>
          outbound.record(
            {
              channel: 'EMAIL',
              template: 'appointment-reminder',
              recipient: 'ana@example.com',
              appointmentId: id,
            },
            (outboundId: string, tx: Prisma.TransactionClient) =>
              repo.attachOutbound(reminder.id, outboundId, tx),
          ),
        ),
      ).rejects.toThrow('ReminderOutboundNotAttachable');
      expect(
        await owner.outboundMessage.count({ where: { appointmentId: id } }),
      ).toBe(existing ? 1 : 0);
      expect(
        await owner.appointmentReminder.findUniqueOrThrow({
          where: { id: reminder.id },
        }),
      ).toEqual(reminder);
    },
  );

  it('DX-160 fix2: dos snapshots SENDING sin outbound solo asocian un mensaje y revierten el otro', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const tenant = a.get(TenantContextService);
    const repo = a.get<ReminderRepository>(REMINDER_REPOSITORY);
    const claim = await tenant.run(clinicA.tenantId, () =>
      repo.claim(id, 2, start),
    );
    expect(claim.outboundMessageId).toBeNull();
    const outbound = a.get(OutboundMessages);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = () =>
      tenant.run(clinicA.tenantId, () =>
        outbound.record(
          {
            channel: 'EMAIL',
            template: 'appointment-reminder',
            recipient: 'ana@example.com',
            appointmentId: id,
          },
          async (outboundId: string, tx: Prisma.TransactionClient) => {
            if (++arrived === 2) release();
            await barrier;
            await repo.attachOutbound(claim.id, outboundId, tx);
          },
        ),
      );
    const results = await Promise.allSettled([create(), create()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const messages = await owner.outboundMessage.findMany({
      where: { appointmentId: id },
    });
    expect(messages).toHaveLength(1);
    expect((await records(id))[0]).toMatchObject({
      status: 'SENDING',
      outboundMessageId: messages[0].id,
    });
  });

  it('no envía a canceladas ni a pacientes sin email, y registra el motivo', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
    const cancelled = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
      'CANCELLED',
    );
    const noEmail = await appointment(
      clinicA,
      await patient(clinicA, null),
      start,
    );

    await sweep();
    await releaseDue(clinicA.tenantId);

    expect(await reminderEmails(clinicA.tenantId)).toBe(0);
    expect((await records(cancelled)).map((r) => r.skipReason)).toEqual([
      'CANCELLED',
    ]);
    expect((await records(noEmail)).map((r) => r.skipReason)).toEqual([
      'NO_EMAIL',
    ]);
  });

  it('reprogramada: omite el de la hora vieja (RESCHEDULED) y recalcula el de la nueva', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    await sweep(); // encolado para su hora (dentro de 3 min)

    const moved = new Date(start.getTime() + HOUR);
    await owner.appointment.update({
      where: { id },
      data: { start: moved, end: new Date(moved.getTime() + 30 * MIN) },
    });
    await releaseDue(clinicA.tenantId);
    expect(await reminderEmails(clinicA.tenantId)).toBe(0);

    clock.current = new Date(moved.getTime() - 2 * HOUR - MIN);
    await sweep();
    await releaseDue(clinicA.tenantId);

    expect(await reminderEmails(clinicA.tenantId)).toBe(1);
    expect(
      (await records(id)).map((r) => [
        r.appointmentStart.toISOString(),
        r.status,
        r.skipReason,
      ]),
    ).toEqual([
      [start.toISOString(), 'SKIPPED', 'RESCHEDULED'],
      [moved.toISOString(), 'SENT', null],
    ]);
  });

  it('el enlace automático no borra un «pide llamada» pendiente', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );
    const callback = new Date(Date.now() - HOUR);
    await owner.appointment.update({
      where: { id },
      data: { callbackRequestedAt: callback },
    });
    await sweep();
    await releaseDue(clinicA.tenantId);

    const after = await owner.appointment.findUniqueOrThrow({ where: { id } });
    expect(after.callbackRequestedAt).toEqual(callback);
    expect(after.confirmationSentAt).not.toBeNull();
  });

  it('DX-291: el recordatorio deja constancia de la versión de la política enviada, en el registro y en la cita', async () => {
    await configure(clinicA, [2]);
    const policy = await owner.cancellationPolicyVersion.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: clinicA.locationId,
        version: 1,
        noticeHours: 24,
        suggestedFee: 50000,
        currency: 'COP',
        patientText: 'Avísanos con 24 horas.',
        createdById: clinicA.providerId,
      },
    });
    const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'politica@example.com'),
      start,
    );
    await sweep();
    await releaseDue(clinicA.tenantId);

    const [sent] = await records(id);
    expect(sent).toMatchObject({ status: 'SENT' });
    const reminder = await owner.appointmentReminder.findFirstOrThrow({
      where: { appointmentId: id },
    });
    expect(reminder.policyVersionId).toBe(policy.id);
    const after = await owner.appointment.findUniqueOrThrow({ where: { id } });
    expect(after.policyVersionId).toBe(policy.id);
  });

  it('SEC-036: un trabajo de la clínica B con una cita de A no lee ni envía nada', async () => {
    await configure(clinicA, [2]);
    const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
    const id = await appointment(
      clinicA,
      await patient(clinicA, 'ana@example.com'),
      start,
    );

    // Un payload manipulado: la cita es de A pero el trabajo corre como B.
    await a
      .get(JobQueue)
      .enqueue(
        SEND_REMINDER_JOB,
        { appointmentId: id, leadHours: 2, start: start.toISOString() },
        { tenantId: clinicB.tenantId },
      );
    await drainBoth();

    const job = await owner.job.findFirstOrThrow({
      where: { tenantId: clinicB.tenantId, name: SEND_REMINDER_JOB },
    });
    expect(job.state).toBe('COMPLETED');
    expect(await records(id)).toEqual([]);
    expect(
      await owner.emailOutbox.count({
        where: { tenantId: { in: [clinicA.tenantId, clinicB.tenantId] } },
      }),
    ).toBe(0);
    expect(
      await owner.appointmentConfirmation.count({
        where: { appointmentId: id },
      }),
    ).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  describe('DX-350 · formato y reloj de la sede', () => {
    /** 06:05 UTC = 15:05 en UTC+9 (sin horario de verano), miércoles. */
    const START = new Date('2027-03-10T06:05:00.000Z');

    async function siteWith(
      regional: RegionalFixture,
      name: string,
    ): Promise<Clinic> {
      const location = await owner.location.create({
        data: locationData(regional, { tenantId: clinicA.tenantId, name }),
      });
      return { ...clinicA, locationId: location.id };
    }

    /** Sede creada por una réplica de G1 (sin reloj), como la deja la migración antes del relleno. */
    async function g1Site(name: string, backfill: boolean): Promise<Clinic> {
      const locationId = await g1LocationInsert(
        owner,
        clinicA.tenantId,
        name,
        REGIONAL_TOKYO_FIXTURE,
      );
      if (backfill) {
        // La función que llama la migración (y el barrido): el único relleno.
        await owner.$queryRaw`
          SELECT dx_g1b_backfill_location_hour_cycle(${clinicA.tenantId}::uuid)`;
      }
      return { ...clinicA, locationId };
    }

    /** El envío del trabajo, bajo la clínica de la cita (sin la cola: sin barridos en medio). */
    async function send(site: Clinic, email: string): Promise<string> {
      await configure(site, [2]);
      const id = await appointment(site, await patient(site, email), START);
      await a.get(TenantContextService).run(site.tenantId, () =>
        a.get(SendAppointmentReminder).handle({
          appointmentId: id,
          leadHours: 2,
          start: START.toISOString(),
        }),
      );
      return id;
    }

    const mailTo = async (to: string) => {
      await waitFor(
        () => mailer.sent.some((m) => m.to === to),
        `el despachador entrega a ${to}`,
      );
      return mailer.sent.find((m) => m.to === to)!.text;
    };

    it('reminder for a ja-JP Asia/Tokyo JPY h12 location: 12 h, Spanish words, no decimals', async () => {
      const site = await siteWith(
        { ...REGIONAL_TOKYO_FIXTURE, hourCycle: 'h12' },
        'Sede 12 h',
      );
      await owner.cancellationPolicyVersion.create({
        data: {
          tenantId: site.tenantId,
          locationId: site.locationId,
          version: 1,
          noticeHours: 24,
          suggestedFee: 3000,
          currency: 'JPY',
          patientText: 'Avísanos con 24 horas.',
          createdById: site.providerId,
        },
      });
      await send(site, 'reloj12@example.com');

      const text = await mailTo('reloj12@example.com');
      expect(text).toContain(
        'Fecha y hora: miércoles 10 de marzo de 2027 a las 3:05 p. m. (hora de la sede)',
      );
      expect(text).toContain('un cargo de ￥3,000.');
    });

    it('reminder for a location without hourCycle is not sent', async () => {
      const site = await g1Site('Sin reloj', false);
      const error = await send(site, 'sinreloj@example.com').catch(
        (e: unknown) => e,
      );
      // Mismo camino que una zona NULL: falla el intento (la cola reintenta)
      // y no se reclama ni se encola nada; nunca sale con otro reloj.
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_LOCALE_REQUIRED',
        locationId: site.locationId,
      });
      expect(
        await owner.appointmentReminder.count({
          where: { tenantId: site.tenantId },
        }),
      ).toBe(0);
      expect(await reminderEmails(site.tenantId)).toBe(0);
    });

    it('a location backfilled by the migration renders reminder times in 24 h (ruled change, DX-350)', async () => {
      const site = await g1Site('Rellenada', true);
      expect(
        await owner.location.findUniqueOrThrow({
          where: { id: site.locationId },
          select: { hourCycle: true },
        }),
      ).toEqual({ hourCycle: 'h23' });
      await send(site, 'rellenada@example.com');

      const text = await mailTo('rellenada@example.com');
      expect(text).toContain('a las 15:05 (hora de la sede)');
      expect(text).not.toContain('3:05 p. m.');
    });

    it('policy email preview of a backfilled location is 24 h', async () => {
      const site = await g1Site('Vista previa', true);
      // La vista previa pinta la cita de ejemplo 24 h después de `now`.
      const now = new Date(START.getTime() - 24 * HOUR);
      const rendered = await a
        .get(TenantContextService)
        .run(site.tenantId, () =>
          a.get(PreviewReminderEmailUseCase).execute(site.locationId, now),
        );
      expect(rendered.text).toContain(
        'miércoles 10 de marzo de 2027 a las 15:05',
      );
    });
  });

  describe('DX-128 · canal de contacto y baja', () => {
    const jobsFor = async (tenantId: string) =>
      (
        await owner.job.findMany({
          where: { tenantId, name: SEND_REMINDER_JOB },
          select: { payload: true },
        })
      ).map((j) => (j.payload as { appointmentId: string }).appointmentId);

    it('canal NONE, canal WHATSAPP o con baja: nunca entran en la cola del trabajo programado', async () => {
      await configure(clinicA, [2]);
      // Citas de 5 min seguidas (mismo profesional, sin solaparse) cuyo
      // recordatorio de 2 h cae en la ventana de este barrido.
      const base = Date.now() + 2 * HOUR - 10 * MIN;
      let slot = 0;
      const book = async (
        email: string,
        extra: Partial<Prisma.PatientUncheckedCreateInput> = {},
      ) => {
        const start = new Date(base + 6 * MIN * slot++);
        const created = await owner.appointment.create({
          data: {
            tenantId: clinicA.tenantId,
            locationId: clinicA.locationId,
            patientId: await patient(clinicA, email, extra),
            providerId: clinicA.providerId,
            start,
            end: new Date(start.getTime() + 5 * MIN),
          },
        });
        return created.id;
      };
      const email = await book('ana@example.com');
      const none = await book('bea@example.com', { contactChannel: 'NONE' });
      const whatsapp = await book('cami@example.com', {
        contactChannel: 'WHATSAPP',
        phone: '+573101234567',
      });
      const optedOut = await book('dani@example.com', {
        reminderOptOutAt: new Date(Date.now() - HOUR),
        reminderOptOutSource: 'LINK',
      });

      await sweep();
      await sweep();
      expect(await jobsFor(clinicA.tenantId)).toEqual([email]);
      await releaseDue(clinicA.tenantId);

      expect(await reminderEmails(clinicA.tenantId)).toBe(1);
      for (const id of [none, whatsapp, optedOut]) {
        expect(await records(id)).toEqual([]);
      }
      expect((await records(email)).map((r) => r.status)).toEqual(['SENT']);
    });

    it('«BAJA» por WhatsApp registra la baja al momento y el recordatorio ya encolado no sale', async () => {
      await configure(clinicA, [2]);
      const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
      const patientId = await patient(clinicA, 'ana@example.com', {
        phone: '310 555 0001',
      });
      const id = await appointment(clinicA, patientId, start);
      await sweep(); // encolado para su hora (dentro de 3 min)
      expect(await jobsFor(clinicA.tenantId)).toEqual([id]);

      // Lo que hará el webhook de DX-126 al recibir la respuesta.
      const before = Date.now();
      const result = await a.get(OptOutByMessageUseCase).execute({
        tenantId: clinicA.tenantId,
        fromPhone: '573105550001',
        text: 'Baja',
      });
      expect(result).toEqual({ isOptOut: true, optedOut: [patientId] });
      const row = await owner.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutSource).toBe('MESSAGE');
      expect(row.reminderOptOutAt!.getTime() - before).toBeLessThan(60_000);

      // Auditada sin actor, con el origen.
      const [event] = await owner.auditEvent.findMany({
        where: { tenantId: clinicA.tenantId, patientId },
      });
      expect(event).toMatchObject({
        actorUserId: null,
        action: 'UPDATE',
        resourceType: 'PATIENT',
        metadata: {
          reason: 'REMINDER_OPT_OUT',
          origin: 'MESSAGE',
          changedFields: ['reminderOptOutAt'],
        },
      });

      await releaseDue(clinicA.tenantId);
      expect(await reminderEmails(clinicA.tenantId)).toBe(0);
      expect((await records(id)).map((r) => r.skipReason)).toEqual([
        'OPTED_OUT',
      ]);
    });

    it('la BD solo admite actor vacío para la baja del propio paciente', async () => {
      await expect(
        owner.auditEvent.create({
          data: {
            tenantId: clinicA.tenantId,
            action: 'UPDATE',
            resourceType: 'PATIENT',
            metadata: { reason: 'COMMUNICATION_PREFERENCES_CHANGED' },
          },
        }),
      ).rejects.toThrow(/audit_events_actor_check/);

      // Ni siquiera con el motivo de la baja si no la hizo el propio paciente
      // (origen LINK o MESSAGE, sobre su propia ficha y sin rol).
      const patientId = await patient(clinicA, 'ana@example.com');
      const optOut = {
        tenantId: clinicA.tenantId,
        action: 'UPDATE' as const,
        resourceType: 'PATIENT' as const,
        resourceId: patientId,
        patientId,
        metadata: { reason: 'REMINDER_OPT_OUT', origin: 'LINK' },
      };
      for (const data of [
        {
          ...optOut,
          metadata: { reason: 'REMINDER_OPT_OUT', origin: 'STAFF' },
        },
        { ...optOut, metadata: { reason: 'REMINDER_OPT_OUT' } },
        { ...optOut, metadata: { origin: 'LINK' } },
        { ...optOut, metadata: {} },
        { ...optOut, resourceId: null },
        { ...optOut, patientId: null },
        { ...optOut, resourceId: randomUUID() },
        { ...optOut, actorRole: 'ADMIN' as const },
      ]) {
        await expect(owner.auditEvent.create({ data })).rejects.toThrow(
          /audit_events_actor_check/,
        );
      }
      await expect(
        owner.auditEvent.create({ data: optOut }),
      ).resolves.toMatchObject({ actorUserId: null });
    });

    it('enlaces de baja: RLS forzada y FK compuesta al paciente de la misma clínica', async () => {
      const patientA = await patient(clinicA, 'ana@example.com');
      const prisma = a.get(PrismaService);
      await prisma.runWithTenant(clinicA.tenantId, (tx) =>
        tx.reminderOptOutLink.create({
          data: {
            tenantId: clinicA.tenantId,
            patientId: patientA,
            tokenHash: 'a'.repeat(64),
          },
        }),
      );
      await prisma.runWithTenant(clinicB.tenantId, async (tx) => {
        expect(await tx.reminderOptOutLink.count()).toBe(0);
      });
      await expect(
        prisma.runWithTenant(clinicB.tenantId, (tx) =>
          tx.reminderOptOutLink.create({
            data: {
              tenantId: clinicA.tenantId,
              patientId: patientA,
              tokenHash: 'b'.repeat(64),
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        owner.reminderOptOutLink.create({
          data: {
            tenantId: clinicB.tenantId,
            patientId: patientA,
            tokenHash: 'c'.repeat(64),
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      // Nunca el token en claro: solo un SHA-256 en hex.
      await expect(
        owner.reminderOptOutLink.create({
          data: {
            tenantId: clinicA.tenantId,
            patientId: patientA,
            tokenHash: 'token-en-claro',
          },
        }),
      ).rejects.toThrow(/token_hash_check/);
    });
  });

  describe('RLS entre clínicas', () => {
    it('B no ve ni cambia los ajustes ni los recordatorios de A', async () => {
      await configure(clinicA, [48]);
      const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
      const id = await appointment(
        clinicA,
        await patient(clinicA, null),
        start,
      );
      await configure(clinicA, [2]);
      await sweep();
      await releaseDue(clinicA.tenantId);
      expect(await records(id)).toHaveLength(1);

      const prisma = a.get(PrismaService);
      await prisma.runWithTenant(clinicB.tenantId, async (tx) => {
        expect(await tx.locationReminderSettings.count()).toBe(0);
        expect(await tx.appointmentReminder.count()).toBe(0);
        const updated = await tx.locationReminderSettings.updateMany({
          data: { enabled: false },
        });
        expect(updated.count).toBe(0);
      });

      // Escribir filas de A con el contexto de B: lo para WITH CHECK.
      await expect(
        prisma.runWithTenant(clinicB.tenantId, (tx) =>
          tx.appointmentReminder.create({
            data: {
              tenantId: clinicA.tenantId,
              appointmentId: id,
              leadHours: 24,
              appointmentStart: start,
              status: 'SKIPPED',
              skipReason: 'DISABLED',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        prisma.runWithTenant(clinicB.tenantId, (tx) =>
          tx.locationReminderSettings.create({
            data: {
              tenantId: clinicA.tenantId,
              locationId: clinicA.locationId,
              enabled: false,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);

      // FK compuesta: ni con el tenant de B se puede apuntar a la sede de A.
      await expect(
        owner.locationReminderSettings.create({
          data: {
            tenantId: clinicB.tenantId,
            locationId: clinicA.locationId,
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

      const settings = await owner.locationReminderSettings.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
      });
      expect(settings.enabled).toBe(true);
    });

    it('la BD rechaza ajustes fuera de rango aunque la API no esté delante', async () => {
      for (const leadHours of [[0], [169], [1, 2, 3, 4]]) {
        await expect(
          owner.locationReminderSettings.create({
            data: {
              id: randomUUID(),
              tenantId: clinicA.tenantId,
              locationId: clinicA.locationId,
              leadHours,
            },
          }),
        ).rejects.toThrow(/lead_hours_check/);
      }
      await expect(
        owner.locationReminderSettings.create({
          data: {
            tenantId: clinicA.tenantId,
            locationId: clinicA.locationId,
            enabled: true,
            leadHours: [],
          },
        }),
      ).rejects.toThrow(/enabled_check/);
    });
  });
});
