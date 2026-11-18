import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  loadMailConfig,
  MAIL_CONFIG,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { TenantLinkBaseService } from '../src/shared/tenancy/tenant-link-base.service';
import { GetQuoteFollowUpReportUseCase } from '../src/modules/quote-follow-up/application/quote-follow-up-report.use-case';
import {
  QUOTE_FOLLOW_UP_SEND_JOB,
  QuoteFollowUpSender,
  QuoteFollowUpSweep,
} from '../src/modules/quote-follow-up/application/quote-follow-up-sender';
import { QUOTE_FOLLOW_UP_CLOCK } from '../src/modules/quote-follow-up/domain/ports/quote-follow-up-repository.port';
import { ListPendingFollowUpUseCase } from '../src/modules/treatment-plans/application/use-cases/list-pending-follow-up.use-case';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import { CapturingMailer } from './support/capture-mailer';
import { resetDatabase } from './support/e2e-fixtures';
import {
  caracas,
  plusDays,
  quoteFunnelSeeding,
  type FunnelClinic,
} from './support/quote-funnel-fixtures';

// DX-561 · el seguimiento automático de presupuestos contra Postgres de
// verdad, con la app REAL (AppModule) como `dentalix_app` bajo RLS: el
// barrido y el trabajo por la cola de DX-085, el aviso idempotente por grupo
// y paso, las paradas, las omisiones registradas, la franja, los topes de
// email, el informe, las guardas y la fusión de pacientes. `owner`
// (DIRECT_URL) solo siembra y mira.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Fechas relativas a hoy (en el FUTURO): las solicitudes de firma llevan la
// hora de la BD en `createdAt` (DX-425) y su caducidad sale del reloj del
// trabajo; con fechas fijas en el pasado, `expiresAt > createdAt` fallaría.
// Presentado mañana a las 10:00 de Caracas; el paso 1 (3 días) vence 3 días
// civiles después.
const D0 = addCivilDays(fixedSedeDay(0).day, 1);
const day = (offset: number, hhmm = '10:00') =>
  caracas(addCivilDays(D0, offset), hhmm);
const PRESENTED = day(0);
const DAY3 = day(3);
const DAY10 = day(10);
const DAY21 = day(21);

/** Importes y tratamientos que NUNCA van en el aviso. */
const FORBIDDEN =
  /\b(USD|VES|Bs|resinas?|tratamientos?|procedimientos?|dientes?|total|importes?|precios?)\b|\$|\d+[.,]\d{2}/i;

interface Group {
  patientId: string;
  email: string;
  groupId: string;
  planIds: string[];
}

describe('DX-561 · seguimiento automático de presupuestos (int)', () => {
  const clock = { now: DAY3 };
  const mailer = new CapturingMailer();
  const seed = quoteFunnelSeeding(owner);
  let app: TestingModule;
  let a: FunnelClinic;
  let b: FunnelClinic;
  let n = 0;

  const ctx = () => app.get(TenantContextService);
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    ctx().run(tenantId, fn);
  const asApp = <T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => app.get(PrismaService).runWithTenant(tenantId, fn);
  const send = (c: FunnelClinic, g: Group, step: number) =>
    inTenant(c.tenantId, () =>
      app.get(QuoteFollowUpSender).send(c.tenantId, g.groupId, step),
    );
  const messages = (g: Group) =>
    owner.quoteFollowUpMessage.findMany({
      where: { groupId: g.groupId },
      orderBy: { step: 'asc' },
    });
  const followUpRequests = (g: Group) =>
    owner.signatureRequest.findMany({
      where: { patientId: g.patientId, origin: 'FOLLOW_UP' },
      orderBy: { createdAt: 'asc' },
    });
  const outboxFor = async (g: Group) => {
    const ids = (await messages(g)).map((m) => m.id);
    return owner.emailOutbox.count({
      where: { template: 'QUOTE_FOLLOW_UP', referenceId: { in: ids } },
    });
  };

  async function group(
    c: FunnelClinic,
    opts: {
      options?: number;
      email?: string | null;
      quoteValidUntil?: string;
      contactChannel?: 'EMAIL' | 'WHATSAPP' | 'NONE';
      birthDate?: Date;
      createdById?: string | null;
      presentedAt?: Date;
    } = {},
  ): Promise<Group> {
    n += 1;
    const email =
      opts.email === undefined
        ? `paciente-${n}-${c.tenantId.slice(0, 6)}@seguimiento.test`
        : opts.email;
    const patient = await owner.patient.create({
      data: {
        tenantId: c.tenantId,
        firstName: 'Ana María',
        lastName: `Seguimiento-${n}`,
        email,
        contactChannel: opts.contactChannel ?? 'EMAIL',
        birthDate: opts.birthDate ?? new Date('1990-05-01T00:00:00Z'),
      },
    });
    const rootId = randomUUID();
    const count = opts.options ?? 1;
    const presentedAt = opts.presentedAt ?? PRESENTED;
    const planIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = i === 0 ? rootId : randomUUID();
      await seed.plan(c, {
        id,
        status: 'PRESENTED',
        patientId: patient.id,
        presentedAt: new Date(presentedAt.getTime() + i * 60_000),
        optionGroupId: count > 1 ? rootId : undefined,
        createdById: opts.createdById,
        items: [{ price: 150 + i * 100 }],
      });
      planIds.push(id);
    }
    if (count > 1 || opts.quoteValidUntil) {
      await seed.withoutTriggers((tx) =>
        tx.treatmentPlan.updateMany({
          where: { id: { in: planIds } },
          data: {
            ...(count > 1
              ? { optionLabel: 'Opción A: implante y corona' }
              : {}),
            ...(opts.quoteValidUntil
              ? {
                  quoteIssuedOn: new Date(`${D0}T00:00:00Z`),
                  quoteValidUntil: new Date(
                    `${opts.quoteValidUntil}T00:00:00Z`,
                  ),
                }
              : {}),
          },
        }),
      );
    }
    return {
      patientId: patient.id,
      email: email ?? '',
      groupId: rootId,
      planIds,
    };
  }

  /**
   * Los avisos de una presentación salen con días de diferencia; aquí, con
   * segundos: los emails ya encolados se fechan dos días antes para que el
   * enfriamiento por destinatario (MAIL_RECIPIENT_COOLDOWN_SECONDS) y el tope
   * diario no frenen el paso siguiente.
   */
  async function daysLater(): Promise<void> {
    await owner.$executeRaw`
      UPDATE "email_outbox" SET "createdAt" = "createdAt" - interval '2 days'`;
  }

  async function settings(c: FunnelClinic, enabled = true): Promise<void> {
    await owner.locationQuoteFollowUpSettings.upsert({
      where: {
        tenantId_locationId: { tenantId: c.tenantId, locationId: c.main },
      },
      create: {
        id: randomUUID(),
        tenantId: c.tenantId,
        locationId: c.main,
        enabled,
        offsetsDays: [3, 10, 21],
        sendFromHour: 9,
        sendUntilHour: 19,
      },
      update: { enabled },
    });
  }

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seed.clinic('dx561-int-a');
    b = await seed.clinic('dx561-int-b');
    await settings(a);
    await settings(b);
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(QUOTE_FOLLOW_UP_CLOCK)
      .useValue(() => new Date(clock.now))
      .overrideProvider(MAILER)
      .useValue(mailer)
      // Tope diario de la clínica holgado (el cupo del seguimiento es la mitad:
      // 500); el enfriamiento por destinatario sigue siendo el de verdad.
      .overrideProvider(MAIL_CONFIG)
      .useValue({
        ...loadMailConfig((key) => process.env[key]),
        quotas: {
          ...loadMailConfig((key) => process.env[key]).quotas,
          tenantDaily: 1000,
        },
      })
      .compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner.$disconnect();
  });

  beforeEach(() => {
    clock.now = DAY3;
  });

  it('las tablas nuevas tienen RLS forzada y una clínica no ve los ajustes ni los avisos de otra', async () => {
    const rows = await owner.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relname IN ('location_quote_follow_up_settings', 'quote_follow_up_messages')
       ORDER BY relname`;
    expect(rows).toEqual([
      {
        relname: 'location_quote_follow_up_settings',
        enabled: true,
        forced: true,
      },
      { relname: 'quote_follow_up_messages', enabled: true, forced: true },
    ]);
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    const seenByB = await asApp(b.tenantId, async (tx) => ({
      settings: await tx.locationQuoteFollowUpSettings.count({
        where: { tenantId: a.tenantId },
      }),
      messages: await tx.quoteFollowUpMessage.count({
        where: { groupId: g.groupId },
      }),
    }));
    expect(seenByB).toEqual({ settings: 0, messages: 0 });
    // B manda el grupo de A a su propio trabajo: no existe para B.
    expect(await send(b, g, 1)).toBe('NOOP');
  });

  it('presentado hace 3 días con 3/10/21: el primer aviso sale UNA vez aunque el barrido y el trabajo corran dos veces', async () => {
    const g = await group(a);
    const sweep = app.get(QuoteFollowUpSweep);
    await sweep.run();
    await sweep.run();
    const jobs = await owner.job.findMany({
      where: {
        name: QUOTE_FOLLOW_UP_SEND_JOB,
        payload: { path: ['groupId'], equals: g.groupId },
      },
      select: { tenantId: true, idempotencyKey: true, payload: true },
    });
    expect(jobs).toEqual([
      {
        tenantId: a.tenantId,
        idempotencyKey: `quote-follow-up:${g.groupId}:1:${DAY3.toISOString().slice(0, 13)}`,
        payload: { groupId: g.groupId, step: 1 },
      },
    ]);
    await app.get(JobWorker).drain();
    await app.get(JobWorker).drain();
    // Otra vez el trabajo, a mano: ya está registrado.
    expect(await send(a, g, 1)).toBe('NOOP');
    await sweep.run();
    await app.get(JobWorker).drain();

    const rows = await messages(g);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step: 1,
      status: 'SENT',
      reason: null,
      patientId: g.patientId,
      locationId: a.main,
      planIds: g.planIds,
      language: 'es',
      languageFallbackFrom: null,
    });
    expect(rows[0].recipientMasked).toMatch(/\*\*\*@seguimiento\.test$/);
    expect(await outboxFor(g)).toBe(1);
    const requests = await followUpRequests(g);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: 'BUDGET',
      origin: 'FOLLOW_UP',
      createdById: null,
      treatmentPlanId: g.planIds[0],
      professionalUserId: a.dentist.userId,
      locationId: a.main,
    });
    expect(rows[0].signatureRequestIds).toEqual([requests[0].id]);
    // Auditoría del envío: sin usuario, origen JOB (cláusula del CHECK de actor).
    const events = await owner.auditEvent.findMany({
      where: { resourceType: 'SIGNATURE_REQUEST', resourceId: requests[0].id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'SEND',
      actorUserId: null,
      actorRole: null,
      patientId: g.patientId,
    });
    expect(events[0].metadata).toMatchObject({
      reason: 'QUOTE_FOLLOW_UP_SENT',
      origin: 'JOB',
    });
  });

  it('dos ejecuciones a la vez del mismo paso: un registro, una solicitud y un email', async () => {
    const g = await group(a);
    const results = await Promise.all([send(a, g, 1), send(a, g, 1)]);
    expect(results.sort()).toEqual(['ALREADY_DONE', 'SENT']);
    expect(await messages(g)).toHaveLength(1);
    expect(await followUpRequests(g)).toHaveLength(1);
    expect(await outboxFor(g)).toBe(1);
  });

  it('el mensaje: saludo, texto neutro y el enlace de aceptación, con la baja; sin importes ni tratamientos', async () => {
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    await app.get(EmailDispatcher).whenIdle();
    const email = mailer.sent.filter((m) => m.to === g.email).at(-1)!;
    expect(email.subject).toBe(
      'Tienes un presupuesto pendiente en dx561-int-a',
    );
    expect(email.text).toContain('Hola, Ana');
    expect(email.text).toContain(
      'Tienes un presupuesto pendiente de revisar en dx561-int-a.',
    );
    expect(email.text).toMatch(
      /Ver y aceptar el presupuesto: https?:\/\/dx561-int-a\.[^/\s]+\/firmar\/[A-Za-z0-9_-]{20,}/,
    );
    expect(email.text).toMatch(/\/baja\/[A-Za-z0-9_-]{20,}/);
    expect(email.text).toContain('El enlace caduca en 72 horas.');
    expect(email.text).not.toMatch(FORBIDDEN);
    expect(email.html.replace(/<[^>]+>/g, ' ')).not.toMatch(FORBIDDEN);
  });

  it('A/B: un solo email con «Opción A» y «Opción B» y una solicitud por opción', async () => {
    const g = await group(a, { options: 2 });
    expect(await send(a, g, 1)).toBe('SENT');
    const requests = await followUpRequests(g);
    expect(requests.map((r) => r.treatmentPlanId)).toEqual(g.planIds);
    const [row] = await messages(g);
    expect(row.planIds).toEqual(g.planIds);
    expect(row.signatureRequestIds.sort()).toEqual(
      requests.map((r) => r.id).sort(),
    );
    await app.get(EmailDispatcher).whenIdle();
    const sent = mailer.sent.filter((m) => m.to === g.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain('>Opción A</a>');
    expect(sent[0].html).toContain('>Opción B</a>');
    expect(sent[0].text.match(/\/firmar\//g)).toHaveLength(2);
    // La etiqueta del plan nombra el tratamiento: nunca va en el email.
    expect(sent[0].text).not.toContain('implante');
  });

  it('el aviso siguiente anula sin usuario el enlace del aviso anterior y cancela su email si sigue pendiente', async () => {
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    const [first] = await messages(g);
    // El email del paso 1 aún sin salir.
    await app.get(EmailDispatcher).whenIdle();
    await owner.emailOutbox.updateMany({
      where: { referenceId: first.id },
      data: {
        status: 'PENDING',
        // Un pendiente lleva su payload cifrado (CHECK); no llega a salir.
        payload: Buffer.from('pendiente'),
        nextAttemptAt: plusDays(new Date(), 1),
      },
    });
    clock.now = DAY10;
    await daysLater();
    expect(await send(a, g, 2)).toBe('SENT');
    const requests = await followUpRequests(g);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      revokedById: null,
      revokedByFollowUp: true,
    });
    expect(requests[0].revokedAt).not.toBeNull();
    expect(requests[1]).toMatchObject({ revokedAt: null });
    expect(
      await owner.emailOutbox.findFirstOrThrow({
        where: { referenceId: first.id },
        select: { status: true, lastError: true },
      }),
    ).toEqual({ status: 'FAILED', lastError: 'Superseded' });
  });

  /** Un enlace de presupuesto enviado por la clínica (origin STAFF), con su email pendiente. */
  async function staffLink(g: Group, expiresAt: Date): Promise<string> {
    const createdAt = new Date(expiresAt.getTime() - 72 * 60 * 60 * 1000);
    const request = await owner.signatureRequest.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.main,
        patientId: g.patientId,
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: g.planIds[0],
        title: 'Presupuesto de tratamiento',
        body: 'Condiciones',
        budgetContent: { version: 1 },
        budgetContentHash: 'a'.repeat(64),
        professionalUserId: a.dentist.userId,
        professionalName: 'Dra. Reportes',
        signerType: 'PATIENT',
        signerName: 'Ana María',
        destination: g.email,
        destinationMasked: 'an***@seguimiento.test',
        tokenHash: randomUUID().replace(/-/g, '').repeat(2),
        expiresAt,
        createdById: a.dentist.userId,
        createdAt,
      },
    });
    await owner.emailOutbox.create({
      data: {
        tenantId: a.tenantId,
        template: 'SIGNATURE_REQUEST',
        toHash: 'b'.repeat(64),
        payload: Buffer.from('pendiente'),
        toMasked: 'an***@seguimiento.test',
        referenceId: request.id,
        status: 'PENDING',
        nextAttemptAt: plusDays(new Date(), 1),
        createdAt: plusDays(new Date(), -3),
      },
    });
    return request.id;
  }

  it('un enlace de la clínica vigente no se reemplaza: el paso se aplaza sin registrar nada', async () => {
    const g = await group(a);
    const staffId = await staffLink(g, plusDays(DAY3, 2));
    expect(await send(a, g, 1)).toBe('DEFERRED');
    expect(await messages(g)).toHaveLength(0);
    expect(await followUpRequests(g)).toHaveLength(0);
    expect(
      await owner.reminderOptOutLink.count({
        where: { patientId: g.patientId },
      }),
    ).toBe(0);
    expect(
      await owner.signatureRequest.findUniqueOrThrow({
        where: { id: staffId },
      }),
    ).toMatchObject({ revokedAt: null });
  });

  it('un enlace de la clínica caducado sí se anula (sin usuario) y su email pendiente se cancela', async () => {
    const g = await group(a);
    const staffId = await staffLink(g, plusDays(DAY3, -1));
    expect(await send(a, g, 1)).toBe('SENT');
    expect(
      await owner.signatureRequest.findUniqueOrThrow({
        where: { id: staffId },
      }),
    ).toMatchObject({ revokedById: null, revokedByFollowUp: true });
    expect(
      await owner.emailOutbox.findFirstOrThrow({
        where: { referenceId: staffId },
        select: { status: true },
      }),
    ).toEqual({ status: 'FAILED' });
  });

  it('sin dirección web de la clínica para los enlaces: NO_LINK_HOST', async () => {
    const g = await group(a);
    const spy = jest
      .spyOn(app.get(TenantLinkBaseService), 'forTenant')
      .mockResolvedValueOnce(null);
    expect(await send(a, g, 1)).toBe('SKIPPED');
    spy.mockRestore();
    expect((await messages(g))[0]).toMatchObject({
      status: 'SKIPPED',
      reason: 'NO_LINK_HOST',
    });
  });

  it('opciones presentadas en sedes distintas: un solo aviso, en la sede del primer presupuesto', async () => {
    const g = await group(a, { options: 2 });
    await owner.treatmentPlan.update({
      where: { id: g.planIds[1] },
      data: { presentedLocationId: a.norte },
    });
    expect(await send(a, g, 1)).toBe('SENT');
    const [row] = await messages(g);
    expect(row).toMatchObject({ locationId: a.main, planIds: g.planIds });
    expect((await followUpRequests(g)).map((r) => r.locationId)).toEqual([
      a.main,
      a.main,
    ]);
  });

  it('cupo propio del seguimiento (la mitad del tope diario de la clínica): no encola ni registra lo que no cabe', async () => {
    const c = await seed.clinic('dx561-int-cupo');
    await settings(c);
    const g = await group(c);
    // 500 avisos en las últimas 24 h = el cupo (1000 × 0,5).
    await owner.emailOutbox.createMany({
      data: Array.from({ length: 500 }, () => ({
        tenantId: c.tenantId,
        template: 'QUOTE_FOLLOW_UP' as const,
        toHash: 'c'.repeat(64),
        toMasked: 'x***@seguimiento.test',
        status: 'SENT' as const,
      })),
    });
    await app.get(QuoteFollowUpSweep).run();
    expect(
      await owner.job.count({
        where: {
          name: QUOTE_FOLLOW_UP_SEND_JOB,
          payload: { path: ['groupId'], equals: g.groupId },
        },
      }),
    ).toBe(0);
    expect(await send(c, g, 1)).toBe('QUOTA');
    expect(await messages(g)).toHaveLength(0);
    expect(await followUpRequests(g)).toHaveLength(0);
    // Al día siguiente (fuera de las 24 h) sale.
    await owner.$executeRaw`
      UPDATE "email_outbox" SET "createdAt" = "createdAt" - interval '2 days'
       WHERE "tenantId" = ${c.tenantId}::uuid`;
    await app.get(QuoteFollowUpSweep).run();
    expect(
      await owner.job.count({
        where: {
          name: QUOTE_FOLLOW_UP_SEND_JOB,
          payload: { path: ['groupId'], equals: g.groupId },
        },
      }),
    ).toBe(1);
    expect(await send(c, g, 1)).toBe('SENT');
  });

  it('el barrido no encola un grupo en pausa ni uno con cita antes del primer aviso', async () => {
    const paused = await group(a);
    await owner.treatmentPlan.update({
      where: { id: paused.groupId },
      data: {
        quoteFollowUpPausedAt: new Date(),
        quoteFollowUpPausedById: a.dentist.userId,
      },
    });
    const waiting = await group(a);
    await seed.withoutTriggers((tx) =>
      tx.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.main,
          patientId: waiting.patientId,
          providerId: a.dentist.userId,
          start: day(36, '09:00'),
          end: day(36, '09:30'),
          status: 'SCHEDULED',
        },
      }),
    );
    await app.get(QuoteFollowUpSweep).run();
    for (const g of [paused, waiting]) {
      expect(
        await owner.job.count({
          where: {
            name: QUOTE_FOLLOW_UP_SEND_JOB,
            payload: { path: ['groupId'], equals: g.groupId },
          },
        }),
      ).toBe(0);
    }
  });

  it('aceptar, rechazar o agendar detienen: la parada se registra una vez y no sale nada más', async () => {
    const accepted = await group(a);
    const rejected = await group(a);
    const scheduled = await group(a);
    for (const g of [accepted, rejected, scheduled]) {
      expect(await send(a, g, 1)).toBe('SENT');
    }
    await seed.withoutTriggers(async (tx) => {
      await tx.treatmentPlan.update({
        where: { id: accepted.groupId },
        data: { status: 'ACCEPTED', acceptedAt: plusDays(DAY3, 2) },
      });
      await tx.treatmentPlan.update({
        where: { id: rejected.groupId },
        data: {
          status: 'REJECTED',
          rejectedAt: plusDays(DAY3, 2),
          rejectionReason: 'PRICE',
        },
      });
      await tx.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.main,
          patientId: scheduled.patientId,
          providerId: a.dentist.userId,
          start: day(35, '09:00'),
          end: day(35, '09:30'),
          status: 'SCHEDULED',
        },
      });
    });
    clock.now = DAY10;
    expect(await send(a, accepted, 2)).toBe('SKIPPED');
    expect(await send(a, rejected, 2)).toBe('SKIPPED');
    expect(await send(a, scheduled, 2)).toBe('SKIPPED');
    expect((await messages(accepted)).map((m) => m.reason)).toEqual([
      null,
      'STOPPED_ACCEPTED',
    ]);
    expect((await messages(rejected)).map((m) => m.reason)).toEqual([
      null,
      'STOPPED_REJECTED',
    ]);
    expect((await messages(scheduled)).map((m) => m.reason)).toEqual([
      null,
      'STOPPED_SCHEDULED',
    ]);
    // El día 21 el barrido ya no los encola y el trabajo no hace nada.
    clock.now = DAY21;
    await app.get(QuoteFollowUpSweep).run();
    for (const g of [accepted, rejected, scheduled]) {
      expect(
        await owner.job.count({
          where: {
            name: QUOTE_FOLLOW_UP_SEND_JOB,
            payload: { path: ['groupId'], equals: g.groupId },
            idempotencyKey: { contains: ':3:' },
          },
        }),
      ).toBe(0);
      expect(await send(a, g, 3)).toBe('NOOP');
      expect(await messages(g)).toHaveLength(2);
      expect(await outboxFor(g)).toBe(1);
    }
  });

  it('un presupuesto vencido no recibe el aviso (EXPIRED registrado, sin email ni solicitud)', async () => {
    const g = await group(a, { quoteValidUntil: addCivilDays(D0, 2) });
    expect(await send(a, g, 1)).toBe('SKIPPED');
    expect(await messages(g)).toMatchObject([
      { step: 1, status: 'SKIPPED', reason: 'EXPIRED', sentAt: null },
    ]);
    expect(await followUpRequests(g)).toHaveLength(0);
    expect(await outboxFor(g)).toBe(0);
  });

  it('baja de los avisos o consentimiento revocado: no recibe y la omisión queda registrada', async () => {
    const optedOut = await group(a);
    await owner.patient.update({
      where: { id: optedOut.patientId },
      data: {
        reminderOptOutAt: new Date('2026-11-16T12:00:00Z'),
        reminderOptOutSource: 'STAFF',
      },
    });
    const revoked = await group(a);
    const policy = await owner.privacyPolicyVersion.create({
      data: {
        tenantId: a.tenantId,
        version: 1,
        policyText: 'p',
        generalText: 'g',
        sensitiveHealthText: 's',
        marketingText: 'm',
        contentHash: 'h'.repeat(8),
        publishedById: a.dentist.userId,
      },
    });
    for (const [granted, at] of [
      [true, '2026-10-01T12:00:00Z'],
      [false, '2026-11-16T12:00:00Z'],
    ] as const) {
      await owner.dataProcessingConsent.create({
        data: {
          tenantId: a.tenantId,
          patientId: revoked.patientId,
          policyVersionId: policy.id,
          scope: 'GENERAL',
          granted,
          channel: 'IN_PERSON',
          recordedById: a.dentist.userId,
          recordedAt: new Date(at),
        },
      });
    }
    // Sin ninguna fila de consentimiento no se bloquea (el resto de tests).
    const noEmail = await group(a, { email: null });
    const whatsapp = await group(a, { contactChannel: 'WHATSAPP' });

    for (const g of [optedOut, revoked, noEmail, whatsapp]) {
      expect(await send(a, g, 1)).toBe('SKIPPED');
      expect(await outboxFor(g)).toBe(0);
      expect(await followUpRequests(g)).toHaveLength(0);
    }
    expect((await messages(optedOut))[0].reason).toBe('OPTED_OUT');
    expect((await messages(revoked))[0].reason).toBe('NO_CONSENT');
    expect((await messages(noEmail))[0].reason).toBe('NO_EMAIL');
    expect((await messages(whatsapp))[0].reason).toBe('CHANNEL_WHATSAPP');
    // Una omisión del paciente no cierra la secuencia: el paso 2 se evalúa.
    clock.now = DAY10;
    expect(await send(a, optedOut, 2)).toBe('SKIPPED');
    expect((await messages(optedOut)).map((m) => m.step)).toEqual([1, 2]);
  });

  it('nunca más de 3 avisos por presentación, y los atrasados no se acumulan', async () => {
    const g = await group(a);
    for (const [now, step] of [
      [DAY3, 1],
      [DAY10, 2],
      [DAY21, 3],
    ] as const) {
      clock.now = now;
      await daysLater();
      expect(await send(a, g, step)).toBe('SENT');
    }
    clock.now = day(22);
    await app.get(QuoteFollowUpSweep).run();
    expect(await send(a, g, 3)).toBe('NOOP');
    expect(await messages(g)).toHaveLength(3);

    // Activado tarde (día 11): solo sale el paso 2 y el 1 queda SUPERSEDED.
    const late = await group(a);
    clock.now = day(11);
    expect(await send(a, late, 1)).toBe('STALE');
    expect(await send(a, late, 2)).toBe('SENT');
    expect(
      (await messages(late)).map((m) => [m.step, m.status, m.reason]),
    ).toEqual([
      [1, 'SKIPPED', 'SUPERSEDED'],
      [2, 'SENT', null],
    ]);
    expect(await outboxFor(late)).toBe(1);
  });

  it('nunca fuera de la franja horaria de la sede', async () => {
    const g = await group(a);
    clock.now = day(3, '08:59');
    await app.get(QuoteFollowUpSweep).run();
    expect(
      await owner.job.count({
        where: {
          name: QUOTE_FOLLOW_UP_SEND_JOB,
          payload: { path: ['groupId'], equals: g.groupId },
        },
      }),
    ).toBe(0);
    expect(await send(a, g, 1)).toBe('NOOP');
    clock.now = day(3, '19:00');
    expect(await send(a, g, 1)).toBe('NOOP');
    expect(await messages(g)).toHaveLength(0);
    clock.now = day(3, '18:59');
    expect(await send(a, g, 1)).toBe('SENT');
  });

  it('pausado: no sale nada y no consume pasos; al reanudar sale el que toca', async () => {
    const g = await group(a);
    await owner.treatmentPlan.update({
      where: { id: g.groupId },
      data: {
        quoteFollowUpPausedAt: new Date(),
        quoteFollowUpPausedById: a.dentist.userId,
      },
    });
    expect(await send(a, g, 1)).toBe('NOOP');
    expect(await messages(g)).toHaveLength(0);
    await owner.treatmentPlan.update({
      where: { id: g.groupId },
      data: { quoteFollowUpPausedAt: null, quoteFollowUpPausedById: null },
    });
    expect(await send(a, g, 1)).toBe('SENT');
  });

  it('un menor: el aviso va SOLO a su responsable, que lo recibe con el nombre del paciente', async () => {
    const g = await group(a, {
      birthDate: new Date('2015-03-01T00:00:00Z'),
      email: `menor-${a.tenantId.slice(0, 6)}@seguimiento.test`,
    });
    const guardian = `madre-${a.tenantId.slice(0, 6)}@seguimiento.test`;
    await owner.patientResponsibleParty.create({
      data: {
        tenantId: a.tenantId,
        patientId: g.patientId,
        fullName: 'Carmen Rodríguez',
        email: guardian,
        relationship: 'MOTHER',
        receivesNotices: true,
      },
    });
    expect(await send(a, g, 1)).toBe('SENT');
    await app.get(EmailDispatcher).whenIdle();
    expect(mailer.sent.some((m) => m.to === g.email)).toBe(false);
    const email = mailer.sent.filter((m) => m.to === guardian).at(-1)!;
    expect(email.subject).toBe(
      'Hay un presupuesto de Ana pendiente en dx561-int-a',
    );
    expect(email.text).toContain('Hola, Carmen');
    expect(email.text).toContain('Hay un presupuesto de Ana pendiente');
    expect((await followUpRequests(g))[0]).toMatchObject({
      signerType: 'GUARDIAN',
      destination: guardian,
    });
  });

  it('sin un profesional activo que elaborara el plan: NO_PROFESSIONAL', async () => {
    const former = await seed.formerMember(a, 'Dr. Ex Miembro');
    const g = await group(a, { createdById: former });
    expect(await send(a, g, 1)).toBe('SKIPPED');
    expect((await messages(g))[0].reason).toBe('NO_PROFESSIONAL');
  });

  it('tope de emails superado: no registra nada (ni solicitud) y la pasada siguiente lo reintenta', async () => {
    const g = await group(a);
    // Otro email al mismo destinatario hace un momento: el enfriamiento
    // (MAIL_RECIPIENT_COOLDOWN_SECONDS) lo frena.
    await app.get(EmailOutbox).enqueue({
      tenantId: a.tenantId,
      to: g.email,
      template: 'payment-report-rejected',
      vars: { patientFirstName: 'Ana', clinicName: 'dx561-int-a' },
    });
    expect(await send(a, g, 1)).toBe('QUOTA');
    expect(await messages(g)).toHaveLength(0);
    expect(await followUpRequests(g)).toHaveLength(0);
    // La baja va en la transacción del aviso: no queda ningún enlace suelto.
    expect(
      await owner.reminderOptOutLink.count({
        where: { patientId: g.patientId },
      }),
    ).toBe(0);
    // La pasada siguiente (otra hora, otra clave) lo vuelve a encolar.
    await owner.emailOutbox.deleteMany({
      where: { template: 'PAYMENT_REPORT_REJECTED' },
    });
    clock.now = day(3, '11:00');
    await app.get(QuoteFollowUpSweep).run();
    expect(
      await owner.job.count({
        where: {
          name: QUOTE_FOLLOW_UP_SEND_JOB,
          payload: { path: ['groupId'], equals: g.groupId },
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await send(a, g, 1)).toBe('SENT');
  });

  it('tasa de aceptación a 14 días: cuenta la aceptación de cualquier opción del grupo en [envío, envío + 14 d]', async () => {
    const c = await seed.clinic('dx561-int-report');
    await settings(c);
    const within = await group(c, { options: 2 });
    const after = await group(c);
    const never = await group(c);
    for (const g of [within, after, never]) {
      expect(await send(c, g, 1)).toBe('SENT');
    }
    const optedOut = await group(c);
    await owner.patient.update({
      where: { id: optedOut.patientId },
      data: {
        reminderOptOutAt: new Date('2026-11-16T12:00:00Z'),
        reminderOptOutSource: 'STAFF',
      },
    });
    expect(await send(c, optedOut, 1)).toBe('SKIPPED');
    await seed.withoutTriggers(async (tx) => {
      // La opción B del primero, 13 días después; el segundo, a los 20.
      await tx.treatmentPlan.update({
        where: { id: within.planIds[1] },
        data: { status: 'ACCEPTED', acceptedAt: plusDays(DAY3, 13) },
      });
      await tx.treatmentPlan.update({
        where: { id: after.groupId },
        data: { status: 'ACCEPTED', acceptedAt: plusDays(DAY3, 20) },
      });
      // El primero abrió el enlace.
      await tx.signatureRequest.updateMany({
        where: { patientId: within.patientId, origin: 'FOLLOW_UP' },
        data: { openedAt: plusDays(DAY3, 1) },
      });
    });
    const report = await inTenant(c.tenantId, () =>
      app.get(GetQuoteFollowUpReportUseCase).execute({
        from: D0,
        to: addCivilDays(D0, 30),
        actor: { userId: c.dentist.userId, role: 'ADMIN', permissions: [] },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(report.steps[0]).toEqual({
      step: 1,
      sent: 3,
      opened: 1,
      acceptedWithin14Days: 1,
      openRate: 33.3,
      acceptanceRate: 33.3,
    });
    expect(report.total).toMatchObject({ sent: 3, acceptedWithin14Days: 1 });
    expect(report.skipped).toEqual([{ reason: 'OPTED_OUT', count: 1 }]);
    // Un DENTIST sin el permiso: solo lo que elaboró (aquí, otro profesional).
    const own = await inTenant(c.tenantId, () =>
      app.get(GetQuoteFollowUpReportUseCase).execute({
        from: D0,
        to: addCivilDays(D0, 30),
        actor: { userId: c.otherDentistId, role: 'DENTIST', permissions: [] },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(own.scope).toBe('OWN');
    expect(own.total.sent).toBe(0);
  });

  it('guardas: un aviso no se modifica ni se borra; la app no puede ni intentarlo', async () => {
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    const [row] = await messages(g);
    for (const sql of [
      Prisma.sql`UPDATE "quote_follow_up_messages" SET "step" = 2 WHERE "id" = ${row.id}::uuid`,
      Prisma.sql`DELETE FROM "quote_follow_up_messages" WHERE "id" = ${row.id}::uuid`,
    ]) {
      await expect(
        asApp(a.tenantId, (tx) => tx.$executeRaw(sql)),
      ).rejects.toThrow(/permission denied/);
    }
    // Ni el owner (sin la puerta de la fusión) lo cambia.
    await expect(
      owner.$executeRaw`UPDATE "quote_follow_up_messages" SET "reason" = 'NO_EMAIL' WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/quote_follow_up_messages/);
    // Los ajustes no se borran (apagar es enabled = false).
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "location_quote_follow_up_settings" WHERE "tenantId" = ${a.tenantId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    // Coherencia por estado: un SENT sin email no entra.
    await expect(
      owner.$executeRaw`
        INSERT INTO "quote_follow_up_messages"
          ("id", "tenantId", "groupId", "patientId", "locationId", "step", "status")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${g.groupId}::uuid,
                ${g.patientId}::uuid, ${a.main}::uuid, 3, 'SENT')`,
    ).rejects.toThrow(/quote_follow_up_messages_state_check/);
    // UNIQUE (grupo, paso): quote_follow_up_messages_group_step_key.
    await expect(
      owner.$executeRaw`
        INSERT INTO "quote_follow_up_messages"
          ("id", "tenantId", "groupId", "patientId", "locationId", "step", "status", "reason")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${g.groupId}::uuid,
                ${g.patientId}::uuid, ${a.main}::uuid, 1, 'SKIPPED', 'NO_EMAIL')`,
    ).rejects.toThrow(/"tenantId", "groupId", step\)=.* already exists/);
  });

  it('signature_requests: origen y anulación coherentes (CHECK)', async () => {
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    const [request] = await followUpRequests(g);
    // El origen no cambia (guarda) y un FOLLOW_UP no lleva usuario (CHECK).
    await expect(
      owner.$executeRaw`UPDATE "signature_requests" SET "origin" = 'STAFF', "createdById" = ${a.dentist.userId}::uuid WHERE "id" = ${request.id}::uuid`,
    ).rejects.toThrow(/signature_requests/);
    // Anulado: por una persona o por el seguimiento, nunca por ninguno.
    await expect(
      owner.$executeRaw`UPDATE "signature_requests" SET "revokedAt" = now() WHERE "id" = ${request.id}::uuid`,
    ).rejects.toThrow(/signature_requests_revoked_check/);
    await expect(
      owner.$executeRaw`UPDATE "signature_requests" SET "revokedByFollowUp" = true WHERE "id" = ${request.id}::uuid`,
    ).rejects.toThrow(/signature_requests_revoked_check/);
    // La clínica lo anula con su usuario: vale.
    await owner.$executeRaw`UPDATE "signature_requests" SET "revokedAt" = now(), "revokedById" = ${a.dentist.userId}::uuid WHERE "id" = ${request.id}::uuid`;
  });

  it('fusión de pacientes (DX-266): los avisos del absorbido pasan al conservado', async () => {
    const g = await group(a);
    expect(await send(a, g, 1)).toBe('SENT');
    const kept = await owner.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Ana María',
        lastName: 'Conservada',
      },
    });
    await asApp(
      a.tenantId,
      (tx) =>
        tx.$queryRaw`SELECT dx_merge_patients(${g.patientId}::uuid, ${kept.id}::uuid, ${a.dentist.userId}::uuid)`,
    );
    const rows = await messages(g);
    expect(rows.map((r) => r.patientId)).toEqual([kept.id]);
    const [{ tables }] = await owner.$queryRaw<{ tables: string[] }[]>`
      SELECT dx_patient_merge_tables() AS tables`;
    expect(tables).toContain('quote_follow_up_messages.patientId');
    expect(tables).toContain('post_op_checks.patientId');
  });

  it('pending-follow-up: cada ítem lleva el último aviso y la pausa del grupo', async () => {
    const c = await seed.clinic('dx561-int-list');
    await settings(c);
    // La lista mide «presentado hace más de N días» con el reloj real: esta
    // presentación es de hace 3 días civiles de verdad.
    const today = fixedSedeDay(0).day;
    const g = await group(c, {
      options: 2,
      presentedAt: caracas(addCivilDays(today, -3), '10:00'),
    });
    clock.now = caracas(today, '10:00');
    expect(await send(c, g, 1)).toBe('SENT');
    const page = await inTenant(c.tenantId, () =>
      app.get(ListPendingFollowUpUseCase).execute({ olderThanDays: 0 }),
    );
    const items = page.items.filter((i) => g.planIds.includes(i.planId));
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.followUp).toMatchObject({
        lastStep: 1,
        lastStatus: 'SENT',
        lastReason: null,
        paused: false,
      });
      expect(item.followUp.lastSentAt).toEqual(clock.now);
    }
  });
});
