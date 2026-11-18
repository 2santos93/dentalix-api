import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';
import { signaturePng } from './support/png-fixtures';
import { fixedSedeDay } from './support/sede-clock';
import { COMMISSION_PAYMENT_FORBIDDEN_MESSAGE } from '../src/modules/commissions/presentation/commission-payments.controller';
import { COMMISSION_RECEIPT_LINK_INVALID_MESSAGE } from '../src/modules/commissions/application/commission-receipt-public.use-cases';
import { EXPENSE_COMMISSION_LINKED_MESSAGE } from '../src/modules/expenses/domain/expense-rules';

// DX-464 en HTTP real: pagar una liquidación de honorarios cerrada (gasto de
// la sede en la misma transacción), anular con motivo, PDF solo con
// iniciales, conformidad del profesional por enlace público de un solo uso, y
// quién puede qué (ADMIN todo; DENTIST solo ve el estado de lo suyo;
// RECEPTION nada; otra clínica, 404). Período en el pasado para cualquier
// reloj de la CI: septiembre de 2026.
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const SIGNATURE = `data:image/png;base64,${signaturePng(300, 100).toString('base64')}`;

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Payment {
  id: string;
  currency: string;
  amount: number;
  paidOn: string;
  expenseId: string;
  lineIds: string[];
  voidedAt: string | null;
  voidReason: string | null;
  receipt: { status: string; signerName: string | null };
}
interface Settlement {
  id: string;
  payment: {
    status: string;
    currencies: {
      currency: string;
      total: number;
      paid: number;
      pending: number;
    }[];
  };
  lines: { id: string; amount: number; paidInPaymentId: string | null }[];
  payments: Payment[];
  professionalEmail: string | null;
}

describe('Pago de la liquidación de honorarios (e2e, DX-464)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { userId: string; token: string; email: string };
  let reception: string;
  let settlementId: string;
  let payDay: string;
  let firstPayment: Payment;
  let token: string;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, auth = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${auth}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${auth}`)
        .send(body),
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${auth}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${auth}`)
        .send(body),
  });
  const publicAs = (clinic: Clinic) => ({
    get: (path: string) =>
      request(server()).get(`/api/v1${path}`).set('X-Tenant-Host', clinic.host),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .send(body),
  });
  const settlement = async (auth?: string) =>
    (
      await as(a, auth)
        .get(`/commissions/settlements/${settlementId}`)
        .expect(200)
    ).body as Settlement;

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx464-honorarios-a');
    b = await registerClinic(app, 'dx464-honorarios-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = {
      userId: d.userId,
      email: d.email,
      token: await loginAs(app, a.host, d.email),
    };
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    // Ayer en la sede (DX-449): nunca futuro para la API, corra a la hora que corra.
    payDay = fixedSedeDay(1).day;

    const patient = (
      await as(a)
        .post('/patients', {
          firstName: 'Rosa',
          lastName: 'Pacheco',
          docType: 'NATIONAL_ID',
          docNumber: 'DX464-A',
          sex: 'F',
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const catalog = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX464-RES',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina compuesta',
          category: 'Operatoria',
          color: '#2A2B3C',
          defaultPrice: 100,
        })
        .expect(201)
    ).body as { id: string };
    const plan = (
      await as(a)
        .post(`/patients/${patient.id}/treatment-plans`, { currency: 'USD' })
        .expect(201)
    ).body as { id: string };
    for (const [tooth, day] of [
      ['16', '2026-09-10'],
      ['26', '2026-09-11'],
    ]) {
      const item = (
        await as(a)
          .post(`/treatment-plans/${plan.id}/items`, {
            toothNumber: tooth,
            catalogItemId: catalog.id,
          })
          .expect(201)
      ).body as { id: string };
      await as(a)
        .patch(`/treatment-plans/${plan.id}/items/${item.id}`, {
          status: 'DONE',
          performedById: dentist.userId,
        })
        .expect(200);
      await as(a)
        .patch(`/treatment-plans/${plan.id}/items/${item.id}`, {
          completedAt: `${day}T15:00:00.000Z`,
        })
        .expect(200);
    }
    await as(a)
      .put(`/commissions/rules/${dentist.userId}`, {
        basis: 'PRODUCED',
        releaseMode: 'PER_ITEM',
        percent: 35,
      })
      .expect(200);
    settlementId = (
      (
        await as(a)
          .post('/commissions/settlements', { userId: dentist.userId, ...SEPT })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('una liquidación recién cerrada está pendiente de pago, con su total por moneda', async () => {
    const view = await settlement();
    expect(view.payment).toEqual({
      status: 'UNPAID',
      currencies: [
        { currency: 'USD', total: 70, paid: 0, pending: 70, pendingLines: 2 },
      ],
    });
    expect(view.payments).toEqual([]);
    expect(view.professionalEmail).toBe(dentist.email);
  });

  it('solo ADMIN paga, anula, descarga el PDF y pide la conformidad (403 en español)', async () => {
    const body = { currency: 'USD', paidOn: payDay, method: 'CASH' };
    for (const auth of [dentist.token, reception]) {
      const denied = await as(a, auth)
        .post(`/commissions/settlements/${settlementId}/payments`, body)
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        COMMISSION_PAYMENT_FORBIDDEN_MESSAGE,
      );
      await as(a, auth)
        .get(`/commissions/settlements/${settlementId}/pdf`)
        .expect(403);
    }
  });

  it('ADMIN paga una línea: crea el gasto pagado de la sede y la deja «Pagada parcialmente»', async () => {
    const before = await settlement();
    const line = before.lines[0];
    const res = await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        lineIds: [line.id],
        paidOn: payDay,
        method: 'TRANSFER',
        reference: 'TRF-0042',
      })
      .expect(201);
    firstPayment = res.body as Payment;
    expect(firstPayment).toMatchObject({
      currency: 'USD',
      amount: 35,
      paidOn: payDay,
      lineIds: [line.id],
      voidedAt: null,
      receipt: { status: 'NONE' },
    });
    const expense = (
      await as(a).get(`/expenses/${firstPayment.expenseId}`).expect(200)
    ).body as {
      category: string;
      supplier: string;
      amount: number;
      status: string;
    };
    expect(expense).toMatchObject({ category: 'Honorarios', amount: 35 });
    const after = await settlement();
    expect(after.payment.status).toBe('PARTIALLY_PAID');
    expect(after.lines.find((l) => l.id === line.id)?.paidInPaymentId).toBe(
      firstPayment.id,
    );
    // El DENTIST ve el estado de lo suyo (sin acciones).
    expect((await settlement(dentist.token)).payment.status).toBe(
      'PARTIALLY_PAID',
    );
  });

  it('pagar lo ya pagado → 409; un día cerrado por el cierre contable → 409 PERIOD_LOCKED', async () => {
    const again = await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        lineIds: [firstPayment.lineIds[0]],
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(409);
    expect((again.body as { code: string }).code).toBe(
      'COMMISSION_LINE_ALREADY_PAID',
    );
    const locked = await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: SEPT.to,
        method: 'CASH',
      })
      .expect(409);
    expect((locked.body as { code: string }).code).toBe('PERIOD_LOCKED');
    await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'usd!',
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(400);
  });

  it('el gasto del pago no se anula desde Gastos (409 que remite a la liquidación)', async () => {
    const res = await as(a)
      .post(`/expenses/${firstPayment.expenseId}/void`, {
        reason: 'Anular desde gastos',
      })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      EXPENSE_COMMISSION_LINKED_MESSAGE,
    );
  });

  it('ADMIN paga el resto: «Pagada»; ya no queda nada pendiente (409)', async () => {
    await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(201);
    expect((await settlement()).payment.status).toBe('PAID');
    const nothing = await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(409);
    expect((nothing.body as { code: string }).code).toBe(
      'COMMISSION_NOTHING_PENDING',
    );
  });

  it('PDF de la liquidación: solo iniciales; auditado como EXPORT', async () => {
    const res = await as(a)
      .get(`/commissions/settlements/${settlementId}/pdf`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const exported = await raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        action: 'EXPORT',
        resourceType: 'COMMISSION_SETTLEMENT',
        resourceId: settlementId,
      },
    });
    expect(exported).toBe(1);
  });

  it('conformidad: el enlace público muestra el recibo con iniciales y se firma una sola vez', async () => {
    const link = (
      await as(a)
        .post(`/commissions/payments/${firstPayment.id}/receipt-request`)
        .expect(201)
    ).body as { url: string; expiresAt: string };
    expect(link.url).toMatch(/\/conformidad\/[A-Za-z0-9_-]{43}$/);
    token = link.url.split('/').pop() ?? '';

    // Otra clínica (por host) o un token inventado: el mismo 404.
    await publicAs(b).get(`/public/commission-receipts/${token}`).expect(404);
    const unknown = await publicAs(a)
      .get(`/public/commission-receipts/${'x'.repeat(43)}`)
      .expect(404);
    expect((unknown.body as { message: string }).message).toBe(
      COMMISSION_RECEIPT_LINK_INVALID_MESSAGE,
    );

    const view = (
      await publicAs(a).get(`/public/commission-receipts/${token}`).expect(200)
    ).body as {
      status: string;
      content: {
        lines: { patientInitials: string }[];
        payment: { amount: number };
      };
    };
    expect(view.status).toBe('PENDING');
    expect(view.content.payment.amount).toBe(35);
    expect(view.content.lines.map((l) => l.patientInitials)).toEqual(['R. P.']);
    expect(JSON.stringify(view)).not.toContain('Pacheco');
    await publicAs(a)
      .post(`/public/commission-receipts/${token}/opened`)
      .expect(204);

    await publicAs(a)
      .post(`/public/commission-receipts/${token}/sign`, {
        signerName: 'Dra. Andrea Rivas',
        signature: SIGNATURE,
        accepted: false,
      })
      .expect(400);
    const signed = (
      await publicAs(a)
        .post(`/public/commission-receipts/${token}/sign`, {
          signerName: 'Dra. Andrea Rivas',
          signature: SIGNATURE,
          accepted: true,
        })
        .set('User-Agent', 'e2e-dx464')
        .expect(200)
    ).body as { status: string; signerName: string; signedAt: string };
    expect(signed).toMatchObject({
      status: 'SIGNED',
      signerName: 'Dra. Andrea Rivas',
    });
    const twice = await publicAs(a)
      .post(`/public/commission-receipts/${token}/sign`, {
        signerName: 'Otra persona',
        signature: SIGNATURE,
        accepted: true,
      })
      .expect(409);
    expect((twice.body as { code: string }).code).toBe(
      'COMMISSION_RECEIPT_ALREADY_SIGNED',
    );
    await publicAs(a)
      .get(`/public/commission-receipts/${token}/pdf`)
      .expect(200)
      .expect('Content-Type', 'application/pdf');

    // Queda adjunta al pago, con sus evidencias, y auditada (actor: el profesional).
    const detail = await settlement();
    expect(
      detail.payments.find((p) => p.id === firstPayment.id)?.receipt,
    ).toMatchObject({ status: 'SIGNED', signerName: 'Dra. Andrea Rivas' });
    const row = await raw.commissionReceiptRequest.findFirstOrThrow({
      where: { paymentId: firstPayment.id, signedAt: { not: null } },
    });
    expect(row.userAgent).toBe('e2e-dx464');
    expect(row.ipAddress).toBeTruthy();
    expect(row.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    const sign = await raw.auditEvent.findFirstOrThrow({
      where: { tenantId: a.tenantId, action: 'SIGN', resourceId: settlementId },
    });
    expect(sign.actorUserId).toBe(dentist.userId);
    await as(a)
      .get(`/commissions/payments/${firstPayment.id}/receipt/pdf`)
      .expect(200)
      .expect('Content-Type', 'application/pdf');
    // Ya firmado: no se pide otra.
    await as(a)
      .post(`/commissions/payments/${firstPayment.id}/receipt-request`)
      .expect(409);
  });

  // ISOLATION_COVERS: POST /commissions/settlements/:id/payments
  // ISOLATION_COVERS: GET /commissions/settlements/:id/pdf
  // ISOLATION_COVERS: POST /commissions/payments/:paymentId/void
  // ISOLATION_COVERS: GET /commissions/payments/:paymentId/receipt/pdf
  // ISOLATION_COVERS: POST /commissions/payments/:paymentId/receipt-request
  // ISOLATION_COVERS: GET /public/commission-receipts/:token
  // ISOLATION_COVERS: POST /public/commission-receipts/:token/opened
  // ISOLATION_COVERS: POST /public/commission-receipts/:token/sign
  // ISOLATION_COVERS: GET /public/commission-receipts/:token/pdf
  it('aislamiento: B no paga, no descarga ni pide conformidad de A; los ids de A en el cuerpo de B → 400/404, y A sigue igual', async () => {
    const before = await settlement();
    const lineOfA = before.lines[1].id;
    await as(b)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(404);
    await as(b).get(`/commissions/settlements/${settlementId}/pdf`).expect(404);
    await as(b)
      .post(`/commissions/payments/${firstPayment.id}/void`, {
        reason: 'Desde otra clínica',
      })
      .expect(404);
    await as(b)
      .get(`/commissions/payments/${firstPayment.id}/receipt/pdf`)
      .expect(404);
    await as(b)
      .post(`/commissions/payments/${firstPayment.id}/receipt-request`)
      .expect(404);
    // Enlace de A en el host de B: el mismo 404 en todas las rutas públicas.
    await publicAs(b).get(`/public/commission-receipts/${token}`).expect(404);
    await publicAs(b)
      .post(`/public/commission-receipts/${token}/opened`)
      .expect(404);
    await publicAs(b)
      .post(`/public/commission-receipts/${token}/sign`, {
        signerName: 'Desde B',
        signature: SIGNATURE,
        accepted: true,
      })
      .expect(404);
    await publicAs(b)
      .get(`/public/commission-receipts/${token}/pdf`)
      .expect(404);

    // B cierra la suya y manda en el cuerpo la línea y la sede de A.
    const bDentist = await seedMember(raw, b, ClinicRole.DENTIST);
    const locationOfA = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
      select: { id: true },
    });
    await as(b)
      .put(`/commissions/rules/${bDentist.userId}`, {
        basis: 'PRODUCED',
        releaseMode: 'PER_ITEM',
        percent: 35,
      })
      .expect(200);
    const settlementB = (
      (
        await as(b)
          .post('/commissions/settlements', {
            userId: bDentist.userId,
            ...SEPT,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    // La de B no tiene líneas: con la línea de A, nada que pagar (409).
    await as(b)
      .post(`/commissions/settlements/${settlementB}/payments`, {
        currency: 'USD',
        lineIds: [lineOfA],
        paidOn: payDay,
        method: 'CASH',
      })
      .expect(409);
    const payB = await as(b)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: payDay,
        method: 'CASH',
        locationId: locationOfA.id,
      })
      .expect(404);
    expect((payB.body as { message: string }).message).toBeTruthy();
    expect((await settlement()).payment).toEqual(before.payment);
  });

  it('anular el pago con motivo: anula el gasto y devuelve lo pendiente; otra clínica, 404', async () => {
    await as(b)
      .post(`/commissions/payments/${firstPayment.id}/void`, {
        reason: 'Desde otra clínica',
      })
      .expect(404);
    await as(b).get(`/commissions/settlements/${settlementId}/pdf`).expect(404);
    await as(a, dentist.token)
      .post(`/commissions/payments/${firstPayment.id}/void`, {
        reason: 'Transferencia rebotada',
      })
      .expect(403);
    await as(a)
      .post(`/commissions/payments/${firstPayment.id}/void`, { reason: 'x' })
      .expect(400);
    const voided = (
      await as(a)
        .post(`/commissions/payments/${firstPayment.id}/void`, {
          reason: 'Transferencia rebotada',
        })
        .expect(200)
    ).body as Payment;
    expect(voided).toMatchObject({ voidReason: 'Transferencia rebotada' });
    expect(voided.voidedAt).not.toBeNull();
    const expense = (
      await as(a).get(`/expenses/${firstPayment.expenseId}`).expect(200)
    ).body as { voidedAt: string | null };
    expect(expense.voidedAt).not.toBeNull();
    const view = await settlement();
    expect(view.payment.status).toBe('PARTIALLY_PAID');
    expect(view.payment.currencies[0]).toMatchObject({ paid: 35, pending: 35 });
    await as(a)
      .post(`/commissions/payments/${firstPayment.id}/void`, {
        reason: 'Otra vez',
      })
      .expect(409);
    // A, con la sede de B en el cuerpo: 400 (sede no válida), sin gasto nuevo.
    const locationOfB = await raw.location.findFirstOrThrow({
      where: { tenantId: b.tenantId },
      select: { id: true },
    });
    const expensesBefore = await raw.expense.count({
      where: { tenantId: a.tenantId },
    });
    await as(a)
      .post(`/commissions/settlements/${settlementId}/payments`, {
        currency: 'USD',
        paidOn: payDay,
        method: 'CASH',
        locationId: locationOfB.id,
      })
      .expect(400);
    expect(await raw.expense.count({ where: { tenantId: a.tenantId } })).toBe(
      expensesBefore,
    );
    // El enlace firmado sigue en el pago anulado, pero ya no se abre.
    await publicAs(a).get(`/public/commission-receipts/${token}`).expect(404);
  });
});
