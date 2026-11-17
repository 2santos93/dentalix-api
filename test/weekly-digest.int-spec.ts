import { Test, TestingModule } from '@nestjs/testing';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { GetReceivablesAgingUseCase } from '../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';
import { GetLocationsComparisonUseCase } from '../src/modules/reports/application/use-cases/get-locations-comparison.use-case';
import { GetQuoteFunnelUseCase } from '../src/modules/reports/application/use-cases/get-quote-funnel.use-case';
import { WeeklyDigestComposer } from '../src/modules/weekly-digest/application/weekly-digest-composer';
import {
  WEEKLY_DIGEST_SEND_JOB,
  WeeklyDigestSender,
  WeeklyDigestSweep,
} from '../src/modules/weekly-digest/application/weekly-digest-sender';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
  type DigestClinic,
  type WeeklyDigestRepository,
} from '../src/modules/weekly-digest/domain/ports/weekly-digest-repository.port';
import type {
  DigestMetric,
  WeeklyDigest,
} from '../src/modules/weekly-digest/domain/weekly-digest';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { CapturingMailer } from './support/capture-mailer';
import { resetDatabase } from './support/e2e-fixtures';
import {
  caracas,
  quoteFunnelSeeding,
  type FunnelClinic,
} from './support/quote-funnel-fixtures';

// DX-568 · el resumen semanal contra Postgres de verdad, con la app REAL
// (AppModule) como `dentalix_app` bajo RLS: el barrido y el trabajo por la
// cola de DX-085, el envío idempotente por clínica y semana, las cifras de
// Reportes de la misma semana y sede, la foto de la cartera y su variación,
// y el fallo de una fuente. `owner` (DIRECT_URL) solo siembra y mira.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const WEEK = { weekStart: '2026-11-09', weekEnd: '2026-11-15' };
const PREVIOUS = { weekStart: '2026-11-02', weekEnd: '2026-11-08' };
// Lunes 2026-11-16 08:00 en Caracas: ya pasó el lunes 7:00 de la clínica.
const MONDAY_8 = new Date('2026-11-16T12:00:00Z');
const PATIENT_LAST_NAME = 'Zambrano-Resumen';

interface Admin {
  userId: string;
  membershipId: string;
  email: string;
}

interface DigestClinicFixture extends FunnelClinic {
  owner: Admin;
  unverified: Admin;
  demoted: Admin;
}

describe('DX-568 · resumen semanal por email (int)', () => {
  const clock = { now: MONDAY_8 };
  const mailer = new CapturingMailer();
  const funnelSeed = quoteFunnelSeeding(owner);
  let app: TestingModule;
  let a: DigestClinicFixture;
  let b: DigestClinicFixture;

  const ctx = () => app.get(TenantContextService);
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    ctx().run(tenantId, fn);
  const repo = () => app.get<WeeklyDigestRepository>(WEEKLY_DIGEST_REPOSITORY);

  async function admin(
    c: FunnelClinic,
    name: string,
    verified: boolean,
  ): Promise<Admin> {
    const email = `${name}-${c.tenantId.slice(0, 8)}@resumen.test`;
    const user = await owner.user.create({
      data: {
        email,
        passwordHash: 'x',
        fullName: `Admin ${name}`,
        emailVerifiedAt: verified ? new Date('2026-01-01T00:00:00Z') : null,
      },
    });
    const membership = await owner.clinicMembership.create({
      data: { tenantId: c.tenantId, userId: user.id, role: ClinicRole.ADMIN },
    });
    await owner.weeklyDigestRecipient.create({
      data: { tenantId: c.tenantId, membershipId: membership.id },
    });
    return { userId: user.id, membershipId: membership.id, email };
  }

  async function seedClinic(subdomain: string): Promise<DigestClinicFixture> {
    const c = await funnelSeed.clinic(subdomain);
    await owner.patient.update({
      where: { id: c.patientId },
      data: { lastName: PATIENT_LAST_NAME },
    });
    // Producido y cobrado de la semana (y de la anterior) en la sede principal.
    const planId = await c.seed.plan({
      patientId: c.patientId,
      currency: 'USD',
      price: 300,
      done: { locationId: c.main, at: caracas('2026-11-11') },
    });
    await c.seed.payment({
      planId,
      patientId: c.patientId,
      locationId: c.main,
      currency: 'USD',
      amount: 100,
      paidAt: caracas('2026-11-10'),
    });
    await c.seed.payment({
      planId,
      patientId: c.patientId,
      locationId: c.main,
      currency: 'USD',
      amount: 80,
      paidAt: caracas('2026-11-03'),
    });
    await c.seed.appointments({
      locationId: c.main,
      patientIds: [c.patientId],
      firstDay: '2026-11-10',
      count: 2,
      status: 'COMPLETED',
    });
    await c.seed.appointment({
      locationId: c.main,
      patientId: c.patientId,
      day: '2026-11-13',
      status: 'NO_SHOW',
    });
    // Presupuestos: uno presentado y aceptado esta semana, uno la anterior.
    await funnelSeed.plan(c, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-11-10'),
      acceptedAt: caracas('2026-11-11'),
      items: [{ price: 500, status: 'ACCEPTED' }],
    });
    await funnelSeed.plan(c, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-11-04'),
      items: [{ price: 200 }],
    });
    // Una caja abierta en la sede Norte.
    await owner.cashSession.create({
      data: {
        tenantId: c.tenantId,
        locationId: c.norte,
        openedById: c.dentist.userId,
      },
    });
    const ownerAdmin = await admin(c, 'duena', true);
    const unverified = await admin(c, 'sin-verificar', false);
    const demoted = await admin(c, 'degradada', true);
    // Dejó de ser ADMIN: su fila se conserva, pero no recibe nada.
    await owner.clinicMembership.update({
      where: { id: demoted.membershipId },
      data: { role: ClinicRole.DENTIST },
    });
    await owner.tenant.update({
      where: { id: c.tenantId },
      data: {
        weeklyDigestEnabled: true,
        weeklyDigestWeekday: 1,
        weeklyDigestHour: 7,
      },
    });
    return { ...c, owner: ownerAdmin, unverified, demoted };
  }

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx568-int-a');
    b = await seedClinic('dx568-int-b');
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WEEKLY_DIGEST_CLOCK)
      .useValue(() => new Date(clock.now))
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner.$disconnect();
  });

  const metric = (
    digest: WeeklyDigest,
    locationId: string | null,
    key: DigestMetric['key'],
  ) =>
    digest.sections
      .find((s) => s.locationId === locationId)!
      .metrics.filter((m) => m.key === key);

  async function compose(tenantId: string, week = WEEK): Promise<WeeklyDigest> {
    return inTenant(tenantId, async () => {
      const clinic = (await repo().clinic()) as DigestClinic;
      return (await app.get(WeeklyDigestComposer).compose(clinic, week)).digest;
    });
  }

  it('las tablas nuevas tienen RLS forzada y una clínica no ve las filas de otra', async () => {
    const rows = await owner.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relkind = 'r'
         AND relname LIKE 'weekly_digest_%'
       ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'weekly_digest_deliveries', enabled: true, forced: true },
      { relname: 'weekly_digest_recipients', enabled: true, forced: true },
      { relname: 'weekly_digest_runs', enabled: true, forced: true },
    ]);
    const prisma = app.get(PrismaService);
    const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.weeklyDigestRecipient.findMany({ select: { tenantId: true } }),
    );
    expect(seen.length).toBe(3);
    expect(seen.every((r) => r.tenantId === b.tenantId)).toBe(true);
    // WITH CHECK: B no puede escribir una fila de A.
    await expect(
      prisma.runWithTenant(b.tenantId, (tx) =>
        tx.weeklyDigestRun.create({
          data: { tenantId: a.tenantId, weekStart: new Date('2026-11-09') },
        }),
      ),
    ).rejects.toThrow();
  });

  it('las cifras son las de Reportes para la misma semana y sede', async () => {
    const digest = await compose(a.tenantId);
    const report = await inTenant(a.tenantId, () =>
      app.get(GetLocationsComparisonUseCase).execute({
        from: WEEK.weekStart,
        to: WEEK.weekEnd,
        compare: 'previous',
        allowedLocationIds: 'ALL',
      }),
    );
    const row = report.locations.find((r) => r.locationId === a.main)!;
    const [collected] = metric(digest, a.main, 'collected');
    expect(collected).toMatchObject({
      currency: 'USD',
      current: row.metrics.collected[0].value,
      previous: row.metrics.collected[0].previous,
    });
    expect(collected.current).toBe(100);
    expect(collected.previous).toBe(80);
    expect(metric(digest, a.main, 'completedAppointments')[0].current).toBe(
      row.metrics.completedAppointments.value,
    );
    expect(metric(digest, a.main, 'noShows')[0]).toMatchObject({
      current: 1,
      rate: row.metrics.noShowRate.value,
    });
    expect(metric(digest, null, 'production')[0].current).toBe(
      report.total.metrics.production[0].value,
    );

    const funnel = await inTenant(a.tenantId, () =>
      app.get(GetQuoteFunnelUseCase).execute({
        from: WEEK.weekStart,
        to: WEEK.weekEnd,
        locationId: a.main,
        actor: { userId: a.owner.userId, role: 'ADMIN', permissions: [] },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(metric(digest, a.main, 'quotesPresented')[0]).toMatchObject({
      current: funnel.steps[0].count,
      previous: 1,
      amount: { current: funnel.steps[0].amount },
    });
    expect(metric(digest, a.main, 'quotesAccepted')[0].current).toBe(
      funnel.steps[1].count,
    );
    expect(funnel.steps[0].count).toBe(1);

    const summary = await inTenant(a.tenantId, () =>
      app.get(GetReceivablesAgingUseCase).summary({ locationId: a.main }),
    );
    const usd = summary.totals.find((t) => t.currency === 'USD')!;
    const [overdue] = metric(digest, a.main, 'overdueBalance');
    expect(overdue.current).toBe(
      usd.buckets.days0to30 +
        usd.buckets.days31to60 +
        usd.buckets.days61to90 +
        usd.buckets.over90,
    );
    expect(metric(digest, a.norte, 'openCashSessions')[0].current).toBe(1);
    expect(metric(digest, a.main, 'openCashSessions')[0].current).toBe(0);
    expect(metric(digest, null, 'openCashSessions')[0].current).toBe(1);
  });

  it('el barrido encola la semana que toca solo desde la hora elegida en la zona de la sede', async () => {
    const sweep = app.get(WeeklyDigestSweep);
    // 06:59 en Caracas: aún no toca.
    clock.now = new Date('2026-11-16T10:59:00Z');
    await sweep.run();
    expect(
      await owner.job.count({ where: { name: WEEKLY_DIGEST_SEND_JOB } }),
    ).toBe(0);
    clock.now = MONDAY_8;
    await sweep.run();
    await sweep.run(); // el segundo tick no duplica (clave idempotente)
    const jobs = await owner.job.findMany({
      where: { name: WEEKLY_DIGEST_SEND_JOB },
      select: { tenantId: true, idempotencyKey: true, payload: true },
      orderBy: { tenantId: 'asc' },
    });
    expect(jobs).toEqual(
      [a, b]
        .map((c) => ({
          tenantId: c.tenantId,
          idempotencyKey: `weekly-digest:${c.tenantId}:${WEEK.weekStart}`,
          payload: { weekStart: WEEK.weekStart },
        }))
        .sort((x, y) => x.tenantId.localeCompare(y.tenantId)),
    );
  });

  it('dos ejecuciones a la vez: un envío, una entrega por destinatario válido y un email', async () => {
    const sender = app.get(WeeklyDigestSender);
    const results = await Promise.all([
      inTenant(a.tenantId, () => sender.send(a.tenantId, WEEK.weekStart)),
      inTenant(a.tenantId, () => sender.send(a.tenantId, WEEK.weekStart)),
    ]);
    expect(results.sort()).toEqual(['ALREADY_DONE', 'SENT']);
    // Y el trabajo de la cola (el del barrido) tampoco envía otro.
    await app.get(JobWorker).drain();

    const runs = await owner.weeklyDigestRun.findMany({
      where: { tenantId: a.tenantId },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'SENT',
      recipientCount: 1,
      // La sin verificar y la que ya no es ADMIN se omiten (y se cuentan).
      skippedCount: 2,
    });
    const deliveries = await owner.weeklyDigestDelivery.findMany({
      where: { tenantId: a.tenantId },
    });
    expect(deliveries.map((d) => d.membershipId)).toEqual([
      a.owner.membershipId,
    ]);
    const emails = await owner.emailOutbox.findMany({
      where: { tenantId: a.tenantId, template: 'WEEKLY_DIGEST' },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].referenceId).toBe(deliveries[0].id);
    expect(deliveries[0].emailOutboxId).toBe(emails[0].id);
    // La fila de la degradada sigue: si vuelve a ser ADMIN, lo recibe.
    expect(
      await owner.weeklyDigestRecipient.count({
        where: { membershipId: a.demoted.membershipId },
      }),
    ).toBe(1);
    // B tuvo su propio envío por la cola, sin mezclarse.
    expect(
      await owner.weeklyDigestRun.count({ where: { tenantId: b.tenantId } }),
    ).toBe(1);

    await app.get(EmailDispatcher).whenIdle();
    const sent = mailer.sent.filter((m) => m.to === a.owner.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(
      'Resumen semanal de dx568-int-a: 9 nov–15 nov',
    );
    expect(sent[0].text).not.toContain(PATIENT_LAST_NAME);
    expect(sent[0].html).not.toContain(PATIENT_LAST_NAME);
    expect(sent[0].text).toMatch(/\/resumen\/baja\/[A-Za-z0-9_-]{43}/);
    expect(sent[0].text).toContain(
      `/reportes?tab=comparar-sedes&periodo=custom&desde=${WEEK.weekStart}&hasta=${WEEK.weekEnd}`,
    );
    expect(mailer.sent.some((m) => m.to === a.unverified.email)).toBe(false);
    expect(mailer.sent.some((m) => m.to === a.demoted.email)).toBe(false);
  });

  it('la semana siguiente: variación del saldo frente a la foto y una fuente caída no frena el envío', async () => {
    const [run] = await owner.weeklyDigestRun.findMany({
      where: { tenantId: a.tenantId },
    });
    const snapshot = run.receivablesSnapshot as {
      byLocation: Record<string, Record<string, number>>;
    };
    expect(snapshot.byLocation[a.main]).toBeDefined();

    clock.now = new Date('2026-11-23T12:00:00Z');
    const nextWeek = { weekStart: '2026-11-16', weekEnd: '2026-11-22' };
    const funnel = jest
      .spyOn(app.get(GetQuoteFunnelUseCase), 'execute')
      .mockRejectedValue(new Error('embudo caído'));
    try {
      const digest = await compose(a.tenantId, nextWeek);
      for (const m of metric(digest, a.main, 'overdueBalance')) {
        expect(m.previous).toBe(snapshot.byLocation[a.main][m.currency!] ?? 0);
      }
      expect(metric(digest, a.main, 'quotesPresented')[0].unavailable).toBe(
        true,
      );
      expect(metric(digest, a.main, 'collected')[0].unavailable).toBe(false);

      await expect(
        inTenant(a.tenantId, () =>
          app.get(WeeklyDigestSender).send(a.tenantId, nextWeek.weekStart),
        ),
      ).resolves.toBe('SENT');
    } finally {
      funnel.mockRestore();
    }
    await app.get(EmailDispatcher).whenIdle();
    const last = mailer.sent.filter((m) => m.to === a.owner.email).at(-1)!;
    expect(last.subject).toContain('16 nov–22 nov');
    expect(last.text).toContain('No disponible');
    // Nunca una semana de hace dos: la del 9 ya no se envía.
    await expect(
      inTenant(a.tenantId, () =>
        app.get(WeeklyDigestSender).send(a.tenantId, WEEK.weekStart),
      ),
    ).resolves.toBe('STALE');
    expect(
      await owner.weeklyDigestRun.findMany({
        where: { tenantId: a.tenantId },
        select: { weekStart: true },
        orderBy: { weekStart: 'asc' },
      }),
    ).toEqual([
      { weekStart: new Date(`${WEEK.weekStart}T00:00:00Z`) },
      { weekStart: new Date(`${nextWeek.weekStart}T00:00:00Z`) },
    ]);
  });

  it('la semana anterior de la variación del dinero es la de Reportes (W-1)', async () => {
    clock.now = MONDAY_8;
    const digest = await compose(a.tenantId);
    expect(digest.previousWeek).toEqual(PREVIOUS);
  });
});
