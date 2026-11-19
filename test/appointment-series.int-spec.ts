import { createHash, randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  CancellationReasonCode,
  ClinicRole,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { PrismaAppointmentSeriesRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment-series.repository';
import {
  SeriesSlotWriteError,
  SeriesStaleError,
  type ApplySeriesChangesInput,
  type CreateSeriesRepoInput,
} from '../src/modules/appointments/domain/ports/appointment-series-repository.port';
import { overlapExclusionScope } from '../src/modules/appointments/application/appointment-overlap-error';
import { PrismaReminderRepository } from '../src/modules/reminders/infrastructure/prisma-reminder.repository';
import { OutboundMessages } from '../src/modules/notifications/outbound/application/outbound-messages.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailQuotaExceededError } from '../src/modules/notifications/email/domain/email-quota-exceeded.error';
import type { OutboxQuotaGuard } from '../src/modules/notifications/email/domain/ports/email-outbox-repository.port';
import type { SeriesNoticeWrite } from '../src/modules/appointments/domain/ports/appointment-series-repository.port';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-562, capa BD de las citas en serie por la MISMA ruta que la app
// (runWithTenant, rol dentalix_app, RLS FORCE):
//  - la serie y TODAS sus citas, el evento y el aviso en UNA transacción: si
//    una cita choca en la EXCLUDE, no queda nada;
//  - dos series a la vez sobre el mismo sillón: una gana, la otra choca (sin
//    interbloqueo);
//  - FK compuesta por clínica, CHECK «las dos o ninguna», RLS FORCE;
//  - cancelar y mover «esta y las siguientes» con updateInTx, todo o nada.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx562-int-a', 'dx562-int-b'];
const FAR = Date.now() + 60 * 86_400_000;
// Lunes a las 10:00 de Caracas dentro de unas 9 semanas, y cada semana.
const monday = (() => {
  const d = new Date(FAR);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(14, 0, 0, 0);
  return d.getTime();
})();
const week = (k: number, minutes = 0) =>
  new Date(monday + k * 7 * 86_400_000 + minutes * 60_000);
const slot = (k: number, minutes = 0, duration = 30) => ({
  start: week(k, minutes),
  end: week(k, minutes + duration),
});

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  userId: string;
  otherProviderId: string;
  chairId: string;
}

describe('DX-562 · citas en serie en la BD (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const appointments = new PrismaAppointmentRepository(prisma, tenantContext);
  const repo = new PrismaAppointmentSeriesRepository(
    prisma,
    tenantContext,
    appointments,
    new OutboundMessages(prisma),
  );
  const outbox = new PrismaEmailOutboxRepository(prisma);

  /**
   * El aviso por el insert REAL de email_outbox: candado y recuento del tope
   * en la transacción de la serie y el guarda que decide (como EmailOutbox
   * con `enforceQuota`).
   */
  const notice = (c: Clinic, guard: OutboxQuotaGuard): SeriesNoticeWrite => {
    const outboundId = randomUUID();
    return {
      insert: (tx) =>
        outbox.insertInTx(
          tx,
          {
            tenantId: c.tenantId,
            template: 'appointment-series',
            toHash: createHash('sha256').update(outboundId).digest('hex'),
            toMasked: 'a***@example.com',
            referenceId: outboundId,
            payload: Buffer.from('cifrado'),
          },
          guard,
          'recipient-and-tenant',
        ),
      optOut: {
        patientId: c.patientId,
        tokenHash: createHash('sha256')
          .update(`baja-${outboundId}`)
          .digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 86_400_000),
      },
      outbound: {
        id: outboundId,
        recipient: 'ana@example.com',
        recipientKind: 'PATIENT',
        language: 'es',
        languageFallbackFrom: null,
      },
    };
  };
  let a: Clinic;
  let b: Clinic;

  async function seedClinic(subdomain: string): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Chacao',
      }),
    });
    const patient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Ana',
        lastName: subdomain,
        docNumber: `${subdomain}-1`,
      },
    });
    const otherPatient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Luis',
        lastName: subdomain,
        docNumber: `${subdomain}-2`,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `${subdomain}-${randomUUID()}@example.com`,
        passwordHash: 'x',
        fullName: 'Dra. Rosa Pérez',
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
    });
    const otherProvider = await raw.user.create({
      data: {
        email: `${subdomain}-dent-${randomUUID()}@example.com`,
        passwordHash: 'x',
        fullName: 'Dr. Jesús Rivas',
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: tenant.id,
        userId: otherProvider.id,
        role: ClinicRole.DENTIST,
      },
    });
    const chair = await raw.chair.create({
      data: { tenantId: tenant.id, locationId: location.id, name: 'Sillón 1' },
    });
    return {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      otherPatientId: otherPatient.id,
      userId: user.id,
      otherProviderId: otherProvider.id,
      chairId: chair.id,
    };
  }

  const ctx = (c: Clinic): AuditRequestContext => ({
    tenantId: c.tenantId,
    locationId: c.locationId,
    actor: { userId: c.userId, role: ClinicRole.ADMIN },
    requestId: 'req-dx562',
    ip: null,
    userAgent: null,
  });

  const input = (
    c: Clinic,
    over: Partial<CreateSeriesRepoInput> = {},
  ): CreateSeriesRepoInput => ({
    intervalWeeks: 1,
    patientId: c.patientId,
    providerId: c.userId,
    locationId: c.locationId,
    chairId: null,
    appointmentTypeId: null,
    reason: null,
    notes: null,
    createdById: c.userId,
    actorRole: ClinicRole.ADMIN,
    slots: [slot(0), slot(1), slot(2)],
    audit: ctx(c),
    email: null,
    ...over,
  });

  const asClinic = <T>(c: Clinic, fn: () => Promise<T>) =>
    tenantContext.run(c.tenantId, c.locationId, fn);

  const counts = async (c: Clinic) => ({
    series: await raw.appointmentSeries.count({
      where: { tenantId: c.tenantId },
    }),
    appointments: await raw.appointment.count({
      where: { tenantId: c.tenantId },
    }),
  });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('las migraciones dejan la FK y el CHECK validados, el índice único y la RLS FORCE', async () => {
    const constraints = await raw.$queryRaw<
      { name: string; validated: boolean }[]
    >`
      SELECT conname AS name, convalidated AS validated FROM pg_constraint
       WHERE conname IN ('appointments_series_fkey', 'appointments_series_check')
       ORDER BY conname`;
    expect(constraints).toEqual([
      { name: 'appointments_series_check', validated: true },
      { name: 'appointments_series_fkey', validated: true },
    ]);
    const [index] = await raw.$queryRaw<{ def: string; valid: boolean }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'appointments_tenant_series_index_key'`;
    expect(index.valid).toBe(true);
    expect(index.def).toMatch(/UNIQUE INDEX/);
    expect(index.def).toMatch(/WHERE \("seriesId" IS NOT NULL\)/);
    const [rls] = await raw.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = 'appointment_series'`;
    expect(rls).toEqual({ enabled: true, forced: true });
  });

  it('crea la serie, sus citas por posición, el evento, el aviso y su registro de envío en una transacción', async () => {
    let counted = 0;
    const write = notice(a, () => {
      counted += 1;
    });
    const result = await asClinic(a, () =>
      repo.create(input(a, { email: write })),
    );
    expect(result.notice).toBe('QUEUED');
    expect(counted).toBe(1);
    const emails = await raw.emailOutbox.findMany({
      where: { tenantId: a.tenantId, template: 'APPOINTMENT_SERIES' },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].referenceId).toBe(write.outbound.id);
    const sent = await raw.outboundMessage.findUniqueOrThrow({
      where: { id: write.outbound.id },
    });
    expect(sent).toMatchObject({
      tenantId: a.tenantId,
      channel: 'EMAIL',
      template: 'appointment-series',
      status: 'QUEUED',
      recipientKind: 'PATIENT',
      appointmentId: result.appointments[0].id,
      language: 'es',
    });
    expect(sent.recipientMasked).not.toContain('ana@example.com');
    // DX-128: el enlace de baja del email, en la misma transacción.
    expect(
      await raw.reminderOptOutLink.count({
        where: { tokenHash: write.optOut!.tokenHash },
      }),
    ).toBe(1);
    expect(result.appointments.map((x) => x.series)).toEqual(
      [1, 2, 3].map((index) => ({ id: result.seriesId, index, total: 3 })),
    );
    expect(result.appointments.map((x) => x.start)).toEqual(
      [0, 1, 2].map((k) => week(k)),
    );
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: 'APPOINTMENT_SERIES_CREATED' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      reason: 'APPOINTMENT_SERIES_CREATED',
      appointmentSeries: {
        seriesId: result.seriesId,
        appointmentIds: result.appointments.map((x) => x.id),
        dates: [0, 1, 2].map((k) => week(k).toISOString()),
        intervalWeeks: 1,
      },
    });
  });

  it('tope de emails lleno (visto en la transacción, bajo su candado): la serie se crea igual, sin email ni registro de envío', async () => {
    const write = notice(a, () => {
      throw new EmailQuotaExceededError('La clínica alcanzó el máximo', 3600);
    });
    const before = await raw.emailOutbox.count({
      where: { tenantId: a.tenantId },
    });
    const result = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(5), slot(6)], email: write })),
    );
    expect(result.notice).toBe('QUOTA');
    expect(result.appointments).toHaveLength(2);
    expect(
      await raw.appointmentSeries.count({ where: { id: result.seriesId } }),
    ).toBe(1);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          metadata: {
            path: ['appointmentSeries', 'seriesId'],
            equals: result.seriesId,
          },
        },
      }),
    ).toBe(1);
    expect(
      await raw.emailOutbox.count({ where: { tenantId: a.tenantId } }),
    ).toBe(before);
    expect(
      await raw.outboundMessage.count({ where: { id: write.outbound.id } }),
    ).toBe(0);
    // Sin aviso, sin enlace de baja suelto.
    expect(
      await raw.reminderOptOutLink.count({
        where: { tokenHash: write.optOut!.tokenHash },
      }),
    ).toBe(0);
  });

  it('atomicidad: si la 3.ª choca en la EXCLUDE, no queda ni la serie ni ninguna cita', async () => {
    // Otra cita del profesional en la 3.ª fecha, escrita sin pasar por la app.
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.otherPatientId,
        providerId: a.userId,
        start: week(12),
        end: week(12, 30),
      },
    });
    const before = await counts(a);
    const error = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(10), slot(11), slot(12)] })),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeriesSlotWriteError);
    expect((error as SeriesSlotWriteError).at).toEqual({ position: 2 });
    expect(overlapExclusionScope((error as SeriesSlotWriteError).cause)).toBe(
      'provider',
    );
    expect(await counts(a)).toEqual(before);
  });

  it('dos series a la vez sobre el mismo sillón (otros profesional y paciente): una gana, la otra choca, sin interbloqueo', async () => {
    const results = await Promise.allSettled([
      asClinic(a, () =>
        repo.create(
          input(a, {
            chairId: a.chairId,
            slots: [slot(20), slot(21), slot(22)],
          }),
        ),
      ),
      asClinic(a, () =>
        repo.create(
          input(a, {
            chairId: a.chairId,
            providerId: a.otherProviderId,
            patientId: a.otherPatientId,
            // Las mismas fechas en orden inverso de choque: la 1.ª no choca.
            slots: [slot(19), slot(21, 15), slot(22, 15)],
          }),
        ),
      ),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )!;
    expect(rejected.reason).toBeInstanceOf(SeriesSlotWriteError);
    expect(
      overlapExclusionScope((rejected.reason as SeriesSlotWriteError).cause),
    ).toBe('chair');
  });

  it('FK compuesta y CHECK: una cita no se cuelga de la serie de otra clínica ni lleva solo una de las dos columnas', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(30), slot(31)] })),
    );
    const bAppointment = await raw.appointment.create({
      data: {
        tenantId: b.tenantId,
        locationId: b.locationId,
        patientId: b.patientId,
        providerId: b.userId,
        start: week(30),
        end: week(30, 30),
      },
    });
    await expect(
      raw.$executeRaw`UPDATE "appointments" SET "seriesId" = ${created.seriesId}::uuid, "seriesIndex" = 1 WHERE "id" = ${bAppointment.id}::uuid`,
    ).rejects.toThrow(/appointments_series_fkey/);
    await expect(
      raw.$executeRaw`UPDATE "appointments" SET "seriesIndex" = NULL WHERE "id" = ${created.appointments[0].id}::uuid`,
    ).rejects.toThrow(/appointments_series_check/);
    await expect(
      raw.$executeRaw`UPDATE "appointments" SET "seriesIndex" = 2 WHERE "id" = ${created.appointments[0].id}::uuid`,
    ).rejects.toThrow(/23505.*"seriesIndex"/s);
  });

  it('RLS: otra clínica no ve la serie ni sus citas; la app no puede borrarla', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(40), slot(41)] })),
    );
    expect(await asClinic(b, () => repo.findById(created.seriesId))).toBeNull();
    const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.appointment.count({ where: { seriesId: created.seriesId } }),
    );
    expect(seen).toBe(0);
    const mine = await asClinic(a, () => repo.findById(created.seriesId));
    expect(mine?.appointments).toHaveLength(2);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "appointment_series" WHERE "id" = ${created.seriesId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|permiso/i);
    // Solo se crea: tampoco UPDATE (su estado sale de sus citas).
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "appointment_series" SET "occurrences" = 3 WHERE "id" = ${created.seriesId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  const cancelPatch = (from: AppointmentStatus) => ({
    status: AppointmentStatus.CANCELLED,
    expectStatus: from,
    cancel: {
      byKind: 'CLINIC' as const,
      reasonCode: CancellationReasonCode.CLINIC_RESCHEDULE,
      reasonText: null,
      at: new Date(),
      attended: false,
    },
    confirmationSentAt: null,
    callbackRequestedAt: null,
  });

  it('cancelar todas las pendientes en una transacción: datos de la cancelación y un evento; sin «Pendientes por agendar»', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(50), slot(51), slot(52)] })),
    );
    const updated = await asClinic(a, () =>
      repo.applyChanges({
        changes: created.appointments.map((x) => ({
          id: x.id,
          expect: { status: AppointmentStatus.SCHEDULED, start: x.start },
          patch: cancelPatch(AppointmentStatus.SCHEDULED),
        })),
        lock: null,
        auditEvent: (list) => ({
          tenantId: a.tenantId,
          locationId: a.locationId,
          actor: { kind: 'user', userId: a.userId, role: ClinicRole.ADMIN },
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          resourceId: list[0].id,
          patient: { kind: 'patient', id: a.patientId },
          requestId: null,
          ip: null,
          userAgent: null,
          metadata: {
            reason: 'APPOINTMENT_SERIES_CANCELLED',
            appointmentSeries: {
              seriesId: created.seriesId,
              appointmentIds: list.map((x) => x.id),
            },
          },
        }),
      }),
    );
    expect(updated.map((x) => x.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(updated[0]).toMatchObject({
      cancelledByKind: 'CLINIC',
      lateCancellation: false,
    });
    expect(updated[0].noticeMinutes).toBeGreaterThan(0);
    expect(
      await raw.appointmentWaitlistEntry.count({
        where: { tenantId: a.tenantId },
      }),
    ).toBe(0);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          metadata: {
            path: ['reason'],
            equals: 'APPOINTMENT_SERIES_CANCELLED',
          },
        },
      }),
    ).toBe(1);
  });

  it('cancelar: si otra persona cambió una a la vez (estado leído), SeriesStaleError con la fila bloqueada y no se cancela ninguna', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(60), slot(61)] })),
    );
    await raw.appointment.update({
      where: { id: created.appointments[1].id },
      data: { status: AppointmentStatus.CONFIRMED },
    });
    const error = await asClinic(a, () =>
      repo.applyChanges({
        changes: created.appointments.map((x) => ({
          id: x.id,
          expect: { status: AppointmentStatus.SCHEDULED, start: x.start },
          patch: cancelPatch(AppointmentStatus.SCHEDULED),
        })),
        lock: null,
        auditEvent: () => {
          throw new Error('no debería auditar');
        },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeriesStaleError);
    expect((error as SeriesStaleError).appointmentIds).toEqual([
      created.appointments[1].id,
    ]);
    const rows = await raw.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { seriesIndex: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['SCHEDULED', 'CONFIRMED']);
  });

  it('mover: todo o nada (una que choca deja a las demás donde estaban)', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(70), slot(71)] })),
    );
    // Otra cita del profesional a las 11:00 de la 2.ª fecha.
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.otherPatientId,
        providerId: a.userId,
        start: week(71, 60),
        end: week(71, 90),
      },
    });
    const move = (k: number) => ({
      start: week(k, 60),
      end: week(k, 90),
      confirmationSentAt: null,
      callbackRequestedAt: null,
      revokeConfirmations: true as const,
    });
    const error = await asClinic(a, () =>
      repo.applyChanges({
        changes: [
          {
            id: created.appointments[1].id,
            expect: { status: AppointmentStatus.SCHEDULED, start: week(71) },
            patch: move(71),
          },
          {
            id: created.appointments[0].id,
            expect: { status: AppointmentStatus.SCHEDULED, start: week(70) },
            patch: move(70),
          },
        ].reverse(),
        lock: { providerIds: [a.userId], locationId: a.locationId },
        auditEvent: () => {
          throw new Error('no debería auditar');
        },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeriesSlotWriteError);
    expect((error as SeriesSlotWriteError).at).toEqual({
      appointmentId: created.appointments[1].id,
    });
    const rows = await raw.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { seriesIndex: 'asc' },
    });
    expect(rows.map((r) => r.start)).toEqual([week(70), week(71)]);
  });

  it('mover una semana hacia delante, desde la última: cada una ocupa la hora que deja la siguiente', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(80), slot(81), slot(82)] })),
    );
    const updated = await asClinic(a, () =>
      repo.applyChanges({
        changes: [...created.appointments].reverse().map((x, i) => ({
          id: x.id,
          expect: { status: AppointmentStatus.SCHEDULED, start: x.start },
          patch: {
            start: week(83 - i),
            end: week(83 - i, 30),
            confirmationSentAt: null,
            callbackRequestedAt: null,
            revokeConfirmations: true as const,
          },
        })),
        lock: { providerIds: [a.userId], locationId: a.locationId },
        auditEvent: (list) => ({
          tenantId: a.tenantId,
          locationId: a.locationId,
          actor: { kind: 'user', userId: a.userId, role: ClinicRole.ADMIN },
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          resourceId: list[0].id,
          patient: { kind: 'patient', id: a.patientId },
          requestId: null,
          ip: null,
          userAgent: null,
          metadata: { reason: 'APPOINTMENT_SERIES_MOVED' },
        }),
      }),
    );
    expect(
      updated
        .sort((x, y) => x.series!.index - y.series!.index)
        .map((x) => x.start),
    ).toEqual([week(81), week(82), week(83)]);
  });

  it('recordatorios: el barrido toma cada cita de la serie en su ventana, como una cita suelta', async () => {
    await raw.locationReminderSettings.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        enabled: true,
        leadHours: [24],
      },
    });
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(90), slot(91), slot(92)] })),
    );
    const reminders = new PrismaReminderRepository(prisma, tenantContext);
    for (const appointment of created.appointments) {
      const due = await reminders.dueCandidates(
        a.tenantId,
        new Date(appointment.start.getTime() - 24 * 3_600_000),
      );
      expect(due.map((d) => d.appointmentId)).toContain(appointment.id);
    }
  });

  const audit = (c: Clinic, reason: string) => (list: { id: string }[]) => ({
    tenantId: c.tenantId,
    locationId: c.locationId,
    actor: { kind: 'user' as const, userId: c.userId, role: ClinicRole.ADMIN },
    action: 'UPDATE' as const,
    resourceType: 'APPOINTMENT' as const,
    resourceId: list[0].id,
    patient: { kind: 'patient' as const, id: c.patientId },
    requestId: null,
    ip: null,
    userAgent: null,
    metadata: { reason },
  });

  const moveChanges = (
    list: { id: string; start: Date }[],
    minutes: number,
  ): ApplySeriesChangesInput['changes'] =>
    [...list].reverse().map((x) => ({
      id: x.id,
      expect: { status: AppointmentStatus.SCHEDULED, start: x.start },
      patch: {
        start: new Date(x.start.getTime() + minutes * 60_000),
        end: new Date(x.start.getTime() + (minutes + 30) * 60_000),
        expectStatus: AppointmentStatus.SCHEDULED,
        confirmationSentAt: null,
        callbackRequestedAt: null,
        revokeConfirmations: true as const,
      },
    }));

  /** Ni un interbloqueo sin manejar ni un error que no sea del dominio. */
  const expectNoDeadlock = (results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String((r.reason as Error)?.message)).not.toMatch(
          /40P01|deadlock/i,
        );
        expect(
          r.reason instanceof SeriesStaleError ||
            r.reason instanceof SeriesSlotWriteError ||
            (r.reason as { status?: number })?.status === 409,
        ).toBe(true);
      }
    }
  };

  it('a la vez: mover la serie y un PATCH suelto de una de sus citas (mismo orden fila → agenda): sin interbloqueo', async () => {
    for (let round = 0; round < 3; round++) {
      const created = await asClinic(a, () =>
        repo.create(
          input(a, {
            slots: [slot(100 + round * 3), slot(101 + round * 3)],
          }),
        ),
      );
      const second = created.appointments[1];
      const results = await Promise.allSettled([
        asClinic(a, () =>
          repo.applyChanges({
            changes: moveChanges(created.appointments, 60),
            lock: { providerIds: [a.userId], locationId: a.locationId },
            auditEvent: audit(a, 'APPOINTMENT_SERIES_MOVED'),
          }),
        ),
        asClinic(a, () =>
          appointments.update(second.id, {
            start: new Date(second.start.getTime() + 120 * 60_000),
            end: new Date(second.start.getTime() + 150 * 60_000),
            revokeConfirmations: true,
          }),
        ),
      ]);
      expectNoDeadlock(results);
      // El PATCH suelto siempre se aplica; la serie, o antes (y el PATCH
      // pisa la 2.ª después) o se queda sin escribir porque la 2.ª cambió.
      expect(results[1].status).toBe('fulfilled');
      const row = await raw.appointment.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(row.start).toEqual(
        new Date(second.start.getTime() + 120 * 60_000),
      );
    }
  });

  it('a la vez: cancelar y mover la misma serie: se serializan (candado de series → filas por id); la segunda ve la fila cambiada y no escribe', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(120), slot(121), slot(122)] })),
    );
    const results = await Promise.allSettled([
      asClinic(a, () =>
        repo.applyChanges({
          changes: created.appointments.map((x) => ({
            id: x.id,
            expect: { status: AppointmentStatus.SCHEDULED, start: x.start },
            patch: cancelPatch(AppointmentStatus.SCHEDULED),
          })),
          lock: null,
          auditEvent: audit(a, 'APPOINTMENT_SERIES_CANCELLED'),
        }),
      ),
      asClinic(a, () =>
        repo.applyChanges({
          changes: moveChanges(created.appointments, 60),
          lock: { providerIds: [a.userId], locationId: a.locationId },
          auditEvent: audit(a, 'APPOINTMENT_SERIES_MOVED'),
        }),
      ),
    ]);
    expectNoDeadlock(results);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const lost = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )!;
    expect(lost.reason).toBeInstanceOf(SeriesStaleError);
    const rows = await raw.appointment.findMany({
      where: { seriesId: created.seriesId },
    });
    // Todo de una operación o de la otra, nunca mezclado.
    const cancelled = rows.filter((r) => r.status === 'CANCELLED').length;
    const before = new Map(
      created.appointments.map((x) => [x.id, x.start.getTime()]),
    );
    const moved = rows.filter(
      (r) => r.start.getTime() !== before.get(r.id),
    ).length;
    expect([cancelled, moved].sort()).toEqual([0, 3]);
  });

  it('a la vez: una serie y una cita suelta sobre el mismo profesional y hora: una gana, la otra choca en la EXCLUDE, sin interbloqueo', async () => {
    const results = await Promise.allSettled([
      asClinic(a, () =>
        repo.create(input(a, { slots: [slot(130), slot(131)] })),
      ),
      asClinic(a, () =>
        appointments.create({
          patientId: a.otherPatientId,
          providerId: a.userId,
          locationId: a.locationId,
          start: week(131),
          end: week(131, 30),
          createdById: a.userId,
        }),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const lost = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )!;
    const reason: unknown = lost.reason;
    const cause =
      reason instanceof SeriesSlotWriteError ? reason.cause : reason;
    expect(overlapExclusionScope(cause)).toBe('provider');
  });
});
