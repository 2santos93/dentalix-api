import { randomUUID } from 'node:crypto';
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
  type CreateSeriesRepoInput,
} from '../src/modules/appointments/domain/ports/appointment-series-repository.port';
import { overlapExclusionScope } from '../src/modules/appointments/application/appointment-overlap-error';
import { PrismaReminderRepository } from '../src/modules/reminders/infrastructure/prisma-reminder.repository';
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
  );
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

  it('crea la serie, sus citas por posición, el evento y el aviso en una transacción', async () => {
    let inserted = 0;
    const result = await asClinic(a, () =>
      repo.create(
        input(a, {
          email: {
            insert: (tx) => {
              inserted += 1;
              // Dentro de la transacción: ve la serie que aún no se confirmó.
              return tx.appointmentSeries
                .count()
                .then(() => ({ id: randomUUID() }));
            },
          },
        }),
      ),
    );
    expect(inserted).toBe(1);
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

  it('cancelar todas las pendientes en una transacción: datos de la cancelación, un evento y la serie cancelada; sin «Pendientes por agendar»', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(50), slot(51), slot(52)] })),
    );
    const updated = await asClinic(a, () =>
      repo.applyChanges({
        seriesId: created.seriesId,
        changes: created.appointments.map((x) => ({
          id: x.id,
          patch: cancelPatch(AppointmentStatus.SCHEDULED),
        })),
        lock: null,
        markCancelledBy: a.userId,
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
    const series = await raw.appointmentSeries.findUniqueOrThrow({
      where: { id: created.seriesId },
    });
    expect(series.cancelledById).toBe(a.userId);
    expect(series.cancelledAt).not.toBeNull();
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

  it('cancelar: si otra persona cambió una a la vez (estado leído), no se cancela ninguna', async () => {
    const created = await asClinic(a, () =>
      repo.create(input(a, { slots: [slot(60), slot(61)] })),
    );
    await raw.appointment.update({
      where: { id: created.appointments[1].id },
      data: { status: AppointmentStatus.CONFIRMED },
    });
    const error = await asClinic(a, () =>
      repo.applyChanges({
        seriesId: created.seriesId,
        changes: created.appointments.map((x) => ({
          id: x.id,
          patch: cancelPatch(AppointmentStatus.SCHEDULED),
        })),
        lock: null,
        markCancelledBy: a.userId,
        auditEvent: () => {
          throw new Error('no debería auditar');
        },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeriesSlotWriteError);
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
        seriesId: created.seriesId,
        changes: [
          { id: created.appointments[1].id, patch: move(71) },
          { id: created.appointments[0].id, patch: move(70) },
        ].reverse(),
        lock: { providerIds: [a.userId], locationId: a.locationId },
        markCancelledBy: null,
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
        seriesId: created.seriesId,
        changes: [...created.appointments].reverse().map((x, i) => ({
          id: x.id,
          patch: {
            start: week(83 - i),
            end: week(83 - i, 30),
            confirmationSentAt: null,
            callbackRequestedAt: null,
            revokeConfirmations: true as const,
          },
        })),
        lock: { providerIds: [a.userId], locationId: a.locationId },
        markCancelledBy: null,
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
});
