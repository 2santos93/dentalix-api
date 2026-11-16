import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AnamnesisReminderLinks } from '../src/modules/medical-history-submissions/application/anamnesis-reminder-links';
import { hashAnamnesisToken } from '../src/modules/medical-history-submissions/domain/anamnesis-token';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../src/modules/patients/domain/ports/patient-repository.port';
import { ReminderClock } from '../src/modules/reminders/application/reminder-clock';
import { SendAppointmentReminder } from '../src/modules/reminders/application/send-appointment-reminder';
import { GetAppointmentRemindersUseCase } from '../src/modules/reminders/application/use-cases/get-appointment-reminders.use-case';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../src/shared/tenancy/tenant-link-base.service';
import { CapturingMailer } from './support/capture-mailer';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-290 con la app REAL (AppModule) y Postgres bajo RLS: el handler del
// recordatorio (DX-026) emite el enlace de anamnesis de un paciente nuevo o
// con la anamnesis caducada y lo pone en el email; uno vigente no lo lleva;
// el de un menor va al responsable; un archivado no queda con un enlace vivo;
// y una clínica no emite nada sobre la cita de otra. El host de la clínica se
// fija (TenantLinkBaseService) para que el email lleve enlaces en local.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx290-int-a', 'dx290-int-b'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = 'https://dx290.dentalix.test';
const TOKEN_IN_URL = /\/anamnesis\/([A-Za-z0-9_-]{43})$/;

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
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Altamira',
      address: 'Av. Luis Roche, Caracas',
    }),
  });
  const provider = await owner.user.create({
    data: {
      email: `doc@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Laura Pérez',
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: provider.id, role: 'ADMIN' },
  });
  // Política publicada: sin autorización previa, el formulario la pide.
  await owner.privacyPolicyVersion.create({
    data: {
      tenantId: tenant.id,
      version: 1,
      policyText: 'Política',
      generalText: 'General',
      sensitiveHealthText: 'Salud',
      marketingText: 'Marketing',
      contentHash: `dx290-${subdomain}`,
      publishedById: provider.id,
    },
  });
  await owner.locationReminderSettings.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      enabled: true,
      leadHours: [48, 2],
      sendAnamnesis: true,
    },
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
  if (ids.length === 0) return;
  // Tablas protegidas contra DELETE (envíos de anamnesis, auditoría,
  // versiones de la HC): se vacían con los triggers de usuario apagados,
  // solo para estas clínicas de prueba.
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    const where = { tenantId: { in: ids } };
    await tx.medicalHistorySubmission.deleteMany({ where });
    await tx.medicalHistoryVersion.deleteMany({ where });
    await tx.auditEvent.deleteMany({ where });
    await tx.appointmentReminder.deleteMany({ where });
    await tx.outboundMessage.deleteMany({ where });
    await tx.emailOutbox.deleteMany({ where });
    await tx.appointmentConfirmation.deleteMany({ where });
    await tx.reminderOptOutLink.deleteMany({ where });
    await tx.appointment.deleteMany({ where });
    await tx.patientResponsibleParty.deleteMany({ where });
    await tx.patient.deleteMany({ where });
    await tx.locationReminderSettings.deleteMany({ where });
    await tx.privacyPolicyVersion.deleteMany({ where });
    await tx.clinicMembership.deleteMany({ where });
    await tx.contingencyAgendaSnapshot.deleteMany({ where });
    await tx.location.deleteMany({ where });
    await tx.job.deleteMany({ where });
    await tx.user.deleteMany({
      where: { email: { in: SUBDOMAINS.map((s) => `doc@${s}.test`) } },
    });
    await tx.tenant.deleteMany({ where: { id: { in: ids } } });
  });
}

describe('DX-290 · el recordatorio lleva la anamnesis a nuevos o caducados (int)', () => {
  const clock = new TestClock();
  const mailer = new CapturingMailer();
  let app: TestingModule;
  let clinicA: Clinic;
  let clinicB: Clinic;

  // Una hora distinta por cita: el mismo profesional no se solapa.
  let slot = 0;
  const nextStart = () => new Date(Date.now() + 2 * DAY + slot++ * 2 * HOUR);

  const run = <T>(tenantId: string, fn: () => Promise<T>) =>
    app.get(TenantContextService).run(tenantId, fn);

  async function patient(
    clinic: Clinic,
    extra: Partial<Prisma.PatientUncheckedCreateInput> = {},
  ): Promise<string> {
    const p = await owner.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Mariana',
        lastName: 'Rondón',
        email: `mariana.${Math.random().toString(36).slice(2)}@example.com`,
        birthDate: new Date('1990-03-10'),
        ...extra,
      },
    });
    return p.id;
  }

  async function appointment(clinic: Clinic, patientId: string, start: Date) {
    const a = await owner.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: clinic.locationId,
        patientId,
        providerId: clinic.providerId,
        start,
        end: new Date(start.getTime() + HOUR),
        status: 'SCHEDULED',
      },
    });
    return a.id;
  }

  async function anamnesisVersion(
    clinic: Clinic,
    patientId: string,
    createdAt: Date,
  ) {
    await owner.medicalHistoryVersion.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        version: 1,
        safetyFlags: {},
        hasCriticalAlert: false,
        createdById: clinic.providerId,
        createdAt,
      },
    });
  }

  async function sendReminder(clinic: Clinic, appointmentId: string) {
    const a = await owner.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
    });
    await run(clinic.tenantId, () =>
      app.get(SendAppointmentReminder).handle({
        appointmentId,
        leadHours: 48,
        start: a.start.toISOString(),
      }),
    );
  }

  // email_outbox guarda el email cifrado: se lee lo que el handler encola.
  interface Enqueued {
    outboundId: string;
    to: string;
    vars: { anamnesisUrl?: string; guardianName?: string | null };
  }
  const enqueued: Enqueued[] = [];
  async function reminderVars(appointmentId: string) {
    const outbound = await owner.outboundMessage.findMany({
      where: { appointmentId },
      select: { id: true },
    });
    const ids = new Set(outbound.map((o) => o.id));
    return enqueued.filter((e) => ids.has(e.outboundId)).reverse();
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await cleanup();
    clinicA = await seedClinic(SUBDOMAINS[0]);
    clinicB = await seedClinic(SUBDOMAINS[1]);
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ReminderClock)
      .useValue(clock)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(TenantLinkBaseService)
      .useValue({ forTenant: () => Promise.resolve(BASE) })
      .compile();
    await app.init();
    const outbox = app.get(EmailOutbox);
    const original = outbox.enqueue.bind(outbox);
    jest.spyOn(outbox, 'enqueue').mockImplementation(async (input) => {
      enqueued.push({
        outboundId: input.referenceId ?? '',
        to: input.to,
        vars: input.vars as Enqueued['vars'],
      });
      return original(input);
    });
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(() => {
    clock.current = new Date();
  });

  it('paciente nuevo: el email lleva el enlace de un solo uso, ligado a la cita, sin usuario y auditado', async () => {
    const patientId = await patient(clinicA);
    const start = nextStart();
    const appointmentId = await appointment(clinicA, patientId, start);

    await sendReminder(clinicA, appointmentId);

    const [email] = await reminderVars(appointmentId);
    const url = email.vars.anamnesisUrl ?? '';
    expect(url.startsWith(`${BASE}/anamnesis/`)).toBe(true);
    const token = TOKEN_IN_URL.exec(url)?.[1] ?? '';

    const rows = await owner.medicalHistorySubmission.findMany({
      where: { patientId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointmentId,
      locationId: clinicA.locationId,
      origin: 'REMINDER',
      createdById: null,
      status: 'PENDING_PATIENT',
      tokenHash: hashAnamnesisToken(token),
      revokedAt: null,
    });
    // Caduca al inicio de la cita (antes de los 7 días).
    expect(rows[0].expiresAt.getTime()).toBe(start.getTime());

    const events = await owner.auditEvent.findMany({
      where: { tenantId: clinicA.tenantId, resourceId: rows[0].id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'MEDICAL_HISTORY_SUBMISSION',
      actorUserId: null,
      patientId,
    });
    expect(events[0].metadata).toEqual({
      reason: 'ANAMNESIS_LINK_SENT_WITH_REMINDER',
      origin: 'JOB',
    });
    // Ni el token ni la URL en el evento.
    expect(JSON.stringify(events[0])).not.toContain(token);

    // El panel de la cita lo muestra: «Anamnesis enviada con el recordatorio».
    const panel = await run(clinicA.tenantId, () =>
      app.get(GetAppointmentRemindersUseCase).execute(appointmentId),
    );
    expect(panel.anamnesis).toMatchObject({
      origin: 'REMINDER',
      status: 'PENDING_PATIENT',
    });
  });

  it('anamnesis vigente (hace 3 meses): el recordatorio no lleva enlace', async () => {
    const patientId = await patient(clinicA);
    await anamnesisVersion(clinicA, patientId, new Date(Date.now() - 90 * DAY));
    const appointmentId = await appointment(clinicA, patientId, nextStart());

    await sendReminder(clinicA, appointmentId);

    const [email] = await reminderVars(appointmentId);
    expect(email).toBeDefined();
    expect(email.vars.anamnesisUrl).toBeUndefined();
    expect(
      await owner.medicalHistorySubmission.count({ where: { patientId } }),
    ).toBe(0);
  });

  it('anamnesis de hace 13 meses: caducada, lleva el enlace', async () => {
    const patientId = await patient(clinicA);
    await anamnesisVersion(
      clinicA,
      patientId,
      new Date(Date.now() - 400 * DAY),
    );
    const appointmentId = await appointment(clinicA, patientId, nextStart());
    await sendReminder(clinicA, appointmentId);
    const [email] = await reminderVars(appointmentId);
    expect(email.vars.anamnesisUrl).toMatch(TOKEN_IN_URL);
  });

  it('un segundo recordatorio no deja dos enlaces vivos: el nuevo anula el anterior', async () => {
    const patientId = await patient(clinicA);
    const start = nextStart();
    const appointmentId = await appointment(clinicA, patientId, start);
    await sendReminder(clinicA, appointmentId);
    // Otra antelación de la misma cita (2 h antes), a su hora.
    clock.current = new Date(start.getTime() - 2 * HOUR);
    await run(clinicA.tenantId, () =>
      app.get(SendAppointmentReminder).handle({
        appointmentId,
        leadHours: 2,
        start: start.toISOString(),
      }),
    );
    const rows = await owner.medicalHistorySubmission.findMany({
      where: { patientId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('EXPIRED');
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1].status).toBe('PENDING_PATIENT');
    expect(rows[1].revokedAt).toBeNull();
  });

  it('un menor: el email (con el enlace) va a su responsable', async () => {
    const patientId = await patient(clinicA, {
      firstName: 'Sofía',
      email: null,
      birthDate: new Date(Date.now() - 10 * 365 * DAY),
    });
    await owner.patientResponsibleParty.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        fullName: 'Carmen Rondón',
        email: 'carmen.rondon@example.com',
        relationship: 'MOTHER',
        receivesNotices: true,
      },
    });
    const appointmentId = await appointment(clinicA, patientId, nextStart());
    await sendReminder(clinicA, appointmentId);
    const [email] = await reminderVars(appointmentId);
    expect(email.to).toBe('carmen.rondon@example.com');
    expect(email.vars.guardianName).toBe('Carmen');
    expect(email.vars.anamnesisUrl).toMatch(TOKEN_IN_URL);
  });

  it('un paciente archivado no tiene enlace vivo ni recibe otro', async () => {
    const patientId = await patient(clinicA);
    const start = nextStart();
    const appointmentId = await appointment(clinicA, patientId, start);
    await sendReminder(clinicA, appointmentId);
    expect(
      await owner.medicalHistorySubmission.count({
        where: { patientId, status: 'PENDING_PATIENT' },
      }),
    ).toBe(1);

    // DX-461: archivar (sin citas abiertas) anula sus enlaces vivos.
    await owner.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CANCELLED' },
    });
    await run(clinicA.tenantId, () =>
      app
        .get<PatientRepository>(PATIENT_REPOSITORY)
        .archive(patientId, () => undefined, {
          now: new Date(),
          ctx: {
            tenantId: clinicA.tenantId,
            locationId: null,
            actor: { userId: clinicA.providerId, role: 'ADMIN' },
            requestId: null,
            ip: null,
            userAgent: null,
          },
        }),
    );
    const live = await owner.medicalHistorySubmission.count({
      where: { patientId, status: 'PENDING_PATIENT', revokedAt: null },
    });
    expect(live).toBe(0);

    const outcome = await run(clinicA.tenantId, () =>
      app.get(AnamnesisReminderLinks).issueFor(
        {
          id: appointmentId,
          patientId,
          locationId: clinicA.locationId,
          start,
          timeZone: 'America/Caracas',
        },
        { kind: 'REMINDER' },
        new Date(),
      ),
    );
    expect(outcome).toEqual({ issued: false, reason: 'ARCHIVED' });
    expect(
      await owner.medicalHistorySubmission.count({
        where: { patientId, status: 'PENDING_PATIENT', revokedAt: null },
      }),
    ).toBe(0);
  });

  it('aislamiento: otra clínica no emite nada sobre la cita (ni el paciente) de esta', async () => {
    const patientId = await patient(clinicA);
    const start = nextStart();
    const appointmentId = await appointment(clinicA, patientId, start);

    // El trabajo de B con el id de la cita de A (payload manipulado).
    await sendReminder(clinicB, appointmentId);
    // El servicio, llamado por B con los ids de A.
    const outcome = await run(clinicB.tenantId, () =>
      app.get(AnamnesisReminderLinks).issueFor(
        {
          id: appointmentId,
          patientId,
          locationId: clinicA.locationId,
          start,
          timeZone: 'America/Caracas',
        },
        { kind: 'REMINDER' },
        new Date(),
      ),
    );
    expect(outcome.issued).toBe(false);
    expect(
      await owner.medicalHistorySubmission.count({ where: { patientId } }),
    ).toBe(0);
    expect(await reminderVars(appointmentId)).toEqual([]);
    await expect(
      run(clinicB.tenantId, () =>
        app.get(GetAppointmentRemindersUseCase).execute(appointmentId),
      ),
    ).rejects.toThrow('Cita no encontrada');
  });

  it('con el ajuste de la sede apagado, ningún recordatorio lleva enlace', async () => {
    await owner.locationReminderSettings.update({
      where: {
        tenantId_locationId: {
          tenantId: clinicB.tenantId,
          locationId: clinicB.locationId,
        },
      },
      data: { sendAnamnesis: false },
    });
    const patientId = await patient(clinicB);
    const appointmentId = await appointment(clinicB, patientId, nextStart());
    await sendReminder(clinicB, appointmentId);
    const [email] = await reminderVars(appointmentId);
    expect(email.vars.anamnesisUrl).toBeUndefined();
    expect(
      await owner.medicalHistorySubmission.count({ where: { patientId } }),
    ).toBe(0);
  });
});
