import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  PAYMENT_LINK_REPOSITORY,
  type PaymentLinkRepository,
} from '../src/modules/payment-links/domain/ports/payment-link-repository.port';

// DX-569 contra Postgres: el reporte del paciente por enlace y su
// confirmación. Un solo reporte por enlace aunque lleguen dos a la vez; dos
// confirmaciones a la vez dan UN abono (Idempotency-Key = id del reporte) y
// el reporte queda CONFIRMED en la transacción del abono; la tasa congelada
// es la del día del pago reportado; la referencia repetida no se cruza entre
// clínicas; RLS FORCE en las tres tablas; archivar anula el enlace.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const ZONE = 'America/Caracas';
const today = () => civilDateIn(new Date(), ZONE);
const yesterday = () => addCivilDays(today(), -1);

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

interface Ctx {
  clinic: Clinic;
  locationId: string;
  reception: string;
  methodId: string;
}

describe('enlace de pago y reporte del paciente (DX-569, int)', () => {
  let app: INestApplication<App>;
  let a: Ctx;
  let b: Ctx;
  let seq = 0;
  const rates: Record<string, number> = {};

  const api = (ctx: Ctx, token = ctx.reception) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', ctx.clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', ctx.clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const pub = (ctx: Ctx) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/public/payment-links/${path}`)
        .set('X-Tenant-Host', ctx.clinic.host),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(`/api/v1/public/payment-links/${path}`)
        .set('X-Tenant-Host', ctx.clinic.host)
        .send(body),
  });

  async function setup(subdomain: string): Promise<Ctx> {
    const clinic = await registerClinic(app, subdomain);
    const { email } = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    const reception = await loginAs(app, clinic.host, email);
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
    });
    const transfer = await raw.clinicPaymentMethod.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, legacyMethod: 'TRANSFER' },
    });
    const ctx = {
      clinic,
      locationId: location.id,
      reception,
      methodId: transfer.id,
    };
    await request(app.getHttpServer())
      .patch(`/api/v1/payment-methods/${transfer.id}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send({
        allowInPaymentLink: true,
        requiresReference: true,
        proofPolicy: 'OPTIONAL',
      })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/payment-methods/${transfer.id}/instructions`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send({ holderName: 'Clínica Ejemplo', accountNumber: '0000-1111' })
      .expect(200);
    return ctx;
  }

  async function plan(
    ctx: Ctx,
  ): Promise<{ patientId: string; planId: string }> {
    const patient = await raw.patient.create({
      data: {
        tenantId: ctx.clinic.tenantId,
        firstName: 'Ana María',
        lastName: `Pago${++seq}`,
        email: `ana${seq}@example.com`,
      },
    });
    const created = await raw.treatmentPlan.create({
      data: {
        tenantId: ctx.clinic.tenantId,
        patientId: patient.id,
        currency: 'USD',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        acceptedLocationId: ctx.locationId,
      },
    });
    return { patientId: patient.id, planId: created.id };
  }

  /** Crea el enlace (sin canal) y devuelve su token. */
  async function link(
    ctx: Ctx,
    target: { patientId: string; planId: string },
  ): Promise<string> {
    const res = await api(ctx)
      .post(`/patients/${target.patientId}/payment-links`, {
        target: { treatmentPlanId: target.planId },
        amount: 40,
      })
      .expect(201);
    return (res.body as { url: string }).url.split('/').pop() as string;
  }

  const reportBody = (ctx: Ctx, over: object = {}) => ({
    paymentMethodId: ctx.methodId,
    currency: 'VES',
    amount: Math.round(40 * rates[yesterday()] * 100) / 100,
    reference: `REF-${++seq}`,
    paidOn: yesterday(),
    ...over,
  });

  async function reportId(ctx: Ctx, token: string, body: object) {
    await pub(ctx).post(`${token}/report`, body).expect(201);
    const linkRow = await raw.paymentLink.findFirstOrThrow({
      where: { tenantId: ctx.clinic.tenantId },
      orderBy: { usedAt: { sort: 'desc', nulls: 'last' } },
      include: { report: true },
    });
    return linkRow.report!.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    // Tasas del proveedor ya guardadas (caché global): ayer y hoy en VES.
    await raw.exchangeRateSnapshot.createMany({
      data: [
        { date: yesterday(), currency: 'VES', rate: 200 },
        { date: today(), currency: 'VES', rate: 250 },
      ],
      skipDuplicates: true,
    });
    for (const day of [yesterday(), today()]) {
      const row = await raw.exchangeRateSnapshot.findUniqueOrThrow({
        where: { date_currency: { date: day, currency: 'VES' } },
      });
      rates[day] = Number(row.rate);
    }
    a = await setup('dx569-int-a');
    b = await setup('dx569-int-b');
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('dos reportes a la vez por el mismo enlace: uno solo (201 y 410), auditado sin actor', async () => {
    const target = await plan(a);
    const token = await link(a, target);
    const body = reportBody(a);
    const responses = await Promise.all([
      pub(a).post(`${token}/report`, body),
      pub(a).post(`${token}/report`, body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 410]);
    const gone = responses.find((r) => r.status === 410);
    expect(gone?.body).toMatchObject({
      code: 'PAYMENT_LINK_USED',
      status: 'REPORTED',
    });
    const reports = await raw.paymentReport.findMany({
      where: { patientId: target.patientId },
    });
    expect(reports).toHaveLength(1);
    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'PAYMENT_REPORT', resourceId: reports[0].id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      actorUserId: null,
      actorRole: null,
      patientId: target.patientId,
    });
    expect(events[0].metadata).toMatchObject({
      origin: 'PUBLIC_LINK',
      reason: 'PAYMENT_REPORT_SUBMITTED',
    });
    // Ni importes ni la referencia en el evento.
    expect(JSON.stringify(events[0].metadata)).not.toMatch(/REF-|VES|\d+\.\d/);
    // Ya usado: 410 también al abrirlo.
    await pub(a).get(token).expect(410);
  });

  it('dos confirmaciones a la vez: un solo abono, con la tasa del día del pago, y el reporte CONFIRMED con él', async () => {
    const target = await plan(a);
    const token = await link(a, target);
    const id = await reportId(a, token, reportBody(a));
    const responses = await Promise.all([
      api(a).post(`/payment-reports/${id}/confirm`),
      api(a).post(`/payment-reports/${id}/confirm`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const [first, second] = responses.map(
      (r) => (r.body as { payment: { id: string } }).payment.id,
    );
    expect(second).toBe(first);
    const payments = await raw.payment.findMany({
      where: { idempotencyKey: id },
    });
    expect(payments).toHaveLength(1);
    const [payment] = payments;
    expect(payment.currency).toBe('VES');
    expect(payment.paymentMethodId).toBe(a.methodId);
    // DX-375: congela la tasa del día del pago reportado (ayer), no la de hoy.
    expect(payment.exchangeRateDate?.toISOString().slice(0, 10)).toBe(
      yesterday(),
    );
    expect(Number(payment.exchangeRateFrom)).toBe(rates[yesterday()]);
    const report = await raw.paymentReport.findUniqueOrThrow({
      where: { id },
    });
    expect(report).toMatchObject({
      status: 'CONFIRMED',
      paymentId: payment.id,
    });
    expect(report.decidedById).not.toBeNull();
    // Repetida después, aun con otras correcciones: el mismo abono.
    const again = await api(a)
      .post(`/payment-reports/${id}/confirm`, { amount: 1 })
      .expect(200);
    expect((again.body as { payment: { id: string } }).payment.id).toBe(
      payment.id,
    );
    expect(await raw.payment.count({ where: { idempotencyKey: id } })).toBe(1);
    // Auditado en la transacción del abono: el reporte y el abono.
    const events = await raw.auditEvent.findMany({
      where: {
        OR: [
          { resourceType: 'PAYMENT_REPORT', resourceId: id, action: 'UPDATE' },
          { resourceType: 'PAYMENT', resourceId: payment.id },
        ],
      },
    });
    expect(events.map((e) => e.resourceType).sort()).toEqual([
      'PAYMENT',
      'PAYMENT_REPORT',
    ]);
  });

  it('si el reporte deja de estar pendiente dentro de la transacción, el abono se deshace (409)', async () => {
    const target = await plan(a);
    const token = await link(a, target);
    const id = await reportId(a, token, reportBody(a));
    const repo = app.get<PaymentLinkRepository>(PAYMENT_LINK_REPOSITORY);
    const pending = await raw.paymentReport.findUniqueOrThrow({
      where: { id },
    });
    expect(pending.status).toBe('PENDING');
    // Rechazado por otra persona justo después de leerlo: la lectura del caso
    // de uso aún lo ve pendiente; el UPDATE condicional de la transacción no.
    const realFind = repo.findReport.bind(repo);
    const spy = jest
      .spyOn(repo, 'findReport')
      .mockImplementationOnce(async (reportId) => {
        const row = await realFind(reportId);
        await raw.paymentReport.update({
          where: { id },
          data: {
            status: 'REJECTED',
            rejectReason: 'Duplicado',
            decidedById: a.clinic.adminUserId,
            decidedAt: new Date(),
          },
        });
        return row;
      });
    try {
      const res = await api(a).post(`/payment-reports/${id}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PAYMENT_REPORT_NOT_PENDING' });
    } finally {
      spy.mockRestore();
    }
    // Ni abono ni recibo: la transacción entera se deshizo.
    expect(await raw.payment.count({ where: { idempotencyKey: id } })).toBe(0);
  });

  it('una referencia repetida en otra clínica no se cruza; en la misma, 409 y con motivo pasa', async () => {
    const reference = `MISMA-${Date.now()}`;
    const first = await plan(a);
    const idA = await reportId(
      a,
      await link(a, first),
      reportBody(a, { reference }),
    );
    await api(a).post(`/payment-reports/${idA}/confirm`).expect(200);

    // Otra clínica, la misma referencia: no la ve (RLS), se confirma.
    const other = await plan(b);
    const idB = await reportId(
      b,
      await link(b, other),
      reportBody(b, { reference }),
    );
    await api(b).post(`/payment-reports/${idB}/confirm`).expect(200);

    // La misma clínica: aviso de repetida; con motivo, pasa.
    const again = await plan(a);
    const idA2 = await reportId(
      a,
      await link(a, again),
      reportBody(a, { reference }),
    );
    const dup = await api(a)
      .post(`/payment-reports/${idA2}/confirm`)
      .expect(409);
    expect(dup.body).toMatchObject({ code: 'PAYMENT_REFERENCE_DUPLICATE' });
    expect(
      (await raw.paymentReport.findUniqueOrThrow({ where: { id: idA2 } }))
        .status,
    ).toBe('PENDING');
    await api(a)
      .post(`/payment-reports/${idA2}/confirm`, {
        duplicateReferenceReason: 'El paciente pagó dos cuotas el mismo día',
      })
      .expect(200);
  });

  it('RLS FORCE: otra clínica no ve ni escribe enlaces, reportes ni datos para pagar; la app no borra enlaces ni reportes', async () => {
    const target = await plan(a);
    await reportId(a, await link(a, target), reportBody(a));
    const seen = await asApp(b.clinic.tenantId, async (tx) => ({
      links: await tx.paymentLink.count({
        where: { tenantId: a.clinic.tenantId },
      }),
      reports: await tx.paymentReport.count({
        where: { tenantId: a.clinic.tenantId },
      }),
      instructions: await tx.paymentMethodInstruction.count({
        where: { tenantId: a.clinic.tenantId },
      }),
    }));
    expect(seen).toEqual({ links: 0, reports: 0, instructions: 0 });
    // Las de A existen (con su propio contexto).
    const own = await asApp(a.clinic.tenantId, (tx) =>
      tx.paymentReport.count(),
    );
    expect(own).toBeGreaterThan(0);
    await expect(
      asApp(b.clinic.tenantId, (tx) =>
        tx.paymentMethodInstruction.create({
          data: {
            tenantId: a.clinic.tenantId,
            paymentMethodId: a.methodId,
            note: 'intrusa',
            createdById: b.clinic.adminUserId,
            updatedById: b.clinic.adminUserId,
          },
        }),
      ),
    ).rejects.toThrow();
    for (const table of ['payment_links', 'payment_reports']) {
      await expect(
        asApp(a.clinic.tenantId, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM "${table}"`),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('archivar al paciente anula su enlace de pago vivo: la página da 404', async () => {
    const target = await plan(a);
    const token = await link(a, target);
    await pub(a).get(token).expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/patients/${target.patientId}`)
      .set('X-Tenant-Host', a.clinic.host)
      .set('Authorization', `Bearer ${a.clinic.adminToken}`)
      .expect(204);
    await pub(a).get(token).expect(404);
    const row = await raw.paymentLink.findFirstOrThrow({
      where: { patientId: target.patientId },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.usedAt).toBeNull();
  });
});
