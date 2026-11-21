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
import { LAB_ORDER_COST_FORBIDDEN_MESSAGE } from '../src/modules/lab-orders/presentation/lab-orders.controller';
import { GATEWAY_FEE_PERCENT_MESSAGE } from '../src/modules/payment-methods/application/payment-methods.use-cases';

// DX-018-bis en HTTP real: el costo de la orden de laboratorio (solo ADMIN,
// auditado antes/después) y el % de la pasarela del medio de pago (solo
// ADMIN, auditado) alimentan la regla «40 % de lo cobrado, descontando
// laboratorio y pasarela». Corona de 300 USD con laboratorio de 120 USD y
// endodoncia de 200 USD con laboratorio en VES (no se convierte: aviso, no se
// descuenta), cobradas con tarjeta al 3,5 %. Cerrar congela lo descontado:
// cambiar después el costo, el % o la regla no mueve lo liquidado; anular el
// abono devuelve también lo descontado. Septiembre de 2026 (pasado para
// cualquier reloj de la CI).
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const OCT = { from: '2026-10-01', to: '2026-10-31' };

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Deductions {
  grossBase: number;
  labCost: number;
  cardFeePercent: number | null;
  cardFee: number;
  labCostSkippedCurrencies: string[];
}
interface Line {
  id: string | null;
  kind: 'ACCRUAL' | 'ADJUSTMENT';
  adjustsLineId: string | null;
  treatmentPlanItemId: string;
  payment: { id: string } | null;
  currency: string;
  base: number;
  percent: number;
  amount: number;
  deductions: Deductions;
}
interface Preview {
  lines: Line[];
  totals: { currency: string; accrued: number; adjustments: number }[];
}
interface Settlement {
  id: string;
  deductLabCost: boolean;
  deductCardFee: boolean;
  totals: unknown[];
  lines: Line[];
}
interface LabOrder {
  id: string;
  cost: { amount: string; currency: string } | null;
  treatmentPlanItem: { id: string; planCurrency: string } | null;
}

describe('Honorarios: descontar laboratorio y pasarela (e2e, DX-018-bis)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { userId: string; token: string };
  let receptionA: string;
  let patientA: string;
  let planA: string;
  let crownItem: string;
  let endoItem: string;
  let crownOrder: string;
  let endoOrder: string;
  let cardMethod: string;
  let payment: string;
  let septSettlement: Settlement;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string, body: object = {}) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const idOf = (res: { body: unknown }) => (res.body as { id: string }).id;
  const preview = (period: { from: string; to: string }, token?: string) =>
    as(a, token).get(
      `/commissions/preview?from=${period.from}&to=${period.to}&userId=${dentist.userId}`,
    );
  const lineOf = (lines: Line[], itemId: string) =>
    lines.find((l) => l.kind === 'ACCRUAL' && l.treatmentPlanItemId === itemId);

  async function doneItem(
    catalogItemId: string,
    completedAt: string,
    toothNumber: string,
  ): Promise<string> {
    const item = idOf(
      await as(a)
        .post(`/treatment-plans/${planA}/items`, { toothNumber, catalogItemId })
        .expect(201),
    );
    await as(a)
      .patch(`/treatment-plans/${planA}/items/${item}`, {
        status: 'DONE',
        performedById: dentist.userId,
      })
      .expect(200);
    await as(a)
      .patch(`/treatment-plans/${planA}/items/${item}`, { completedAt })
      .expect(200);
    return item;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx018bis-descuentos-a');
    b = await registerClinic(app, 'dx018bis-descuentos-b');
    const x = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { userId: x.userId, token: await loginAs(app, a.host, x.email) };
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    patientA = idOf(
      await as(a)
        .post('/patients', {
          firstName: 'Rosa',
          lastName: 'Descuentos',
          docType: 'NATIONAL_ID',
          docNumber: 'DX018BIS-A',
          sex: 'F',
        })
        .expect(201),
    );
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const crown = idOf(
      await as(a)
        .post('/catalog/items', {
          code: 'DX018B-COR',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona de zirconio',
          category: 'Prótesis',
          color: '#2A2B3C',
          defaultPrice: 300,
        })
        .expect(201),
    );
    const endo = idOf(
      await as(a)
        .post('/catalog/items', {
          code: 'DX018B-ENDO',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Endodoncia unirradicular',
          category: 'Endodoncia',
          color: '#3A2B3C',
          defaultPrice: 200,
        })
        .expect(201),
    );
    planA = idOf(
      await as(a)
        .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
        .expect(201),
    );
    crownItem = await doneItem(crown, '2026-09-10T15:00:00.000Z', '16');
    endoItem = await doneItem(endo, '2026-09-11T15:00:00.000Z', '21');

    const lab = idOf(
      await as(a)
        .post('/dental-labs', { name: 'Laboratorio Dental Caracas' })
        .expect(201),
    );
    crownOrder = idOf(
      await as(a, dentist.token)
        .post(`/patients/${patientA}/lab-orders`, {
          labId: lab,
          description: 'Corona de zirconio',
          toothNumbers: ['16'],
          treatmentPlanItemId: crownItem,
        })
        .expect(201),
    );
    endoOrder = idOf(
      await as(a, dentist.token)
        .post(`/patients/${patientA}/lab-orders`, {
          labId: lab,
          description: 'Perno colado',
          toothNumbers: ['21'],
          treatmentPlanItemId: endoItem,
        })
        .expect(201),
    );
    // Enviada: el costo se pone igual (el laboratorio factura al entregar).
    await as(a, dentist.token)
      .post(`/lab-orders/${crownOrder}/send`, {})
      .expect(200);

    const methods = (await as(a).get('/payment-methods').expect(200)).body as {
      id: string;
      legacyMethod: string | null;
    }[];
    cardMethod = methods.find((m) => m.legacyMethod === 'CARD')!.id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el costo del laboratorio solo lo pone ADMIN (403 en español) y solo ADMIN lo ve', async () => {
    for (const token of [dentist.token, receptionA]) {
      const denied = await as(a, token)
        .put(`/lab-orders/${crownOrder}/cost`, {
          cost: '120',
          currency: 'USD',
        })
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        LAB_ORDER_COST_FORBIDDEN_MESSAGE,
      );
    }
    const costed = (
      await as(a)
        .put(`/lab-orders/${crownOrder}/cost`, { cost: '120', currency: 'usd' })
        .expect(200)
    ).body as LabOrder;
    expect(costed.cost).toEqual({ amount: '120.00', currency: 'USD' });
    expect(costed.treatmentPlanItem).toMatchObject({
      id: crownItem,
      planCurrency: 'USD',
    });
    await as(a)
      .put(`/lab-orders/${endoOrder}/cost`, { cost: '3650', currency: 'VES' })
      .expect(200);
    const forDentist = (
      await as(a, dentist.token).get(`/lab-orders/${crownOrder}`).expect(200)
    ).body as LabOrder;
    expect(forDentist.cost).toBeNull();

    // Validación: importe sin moneda, decimales de más, moneda inexistente.
    await as(a)
      .put(`/lab-orders/${crownOrder}/cost`, { cost: '120', currency: null })
      .expect(400);
    await as(a)
      .put(`/lab-orders/${crownOrder}/cost`, {
        cost: '12.345',
        currency: 'USD',
      })
      .expect(400);
    await as(a)
      .put(`/lab-orders/${crownOrder}/cost`, { cost: '120', currency: 'XYZ' })
      .expect(422);

    // Auditado con el importe y la moneda antes y después.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'DENTAL_LAB_ORDER',
        resourceId: crownOrder,
        action: 'UPDATE',
      },
      select: { metadata: true, patientId: true },
    });
    const costEvents = events.filter(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'DENTAL_LAB_ORDER_COST_UPDATED',
    );
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0]).toMatchObject({
      patientId: patientA,
      metadata: {
        reason: 'DENTAL_LAB_ORDER_COST_UPDATED',
        changedFields: ['cost'],
        configChange: {
          before: { cost: null, costCurrency: null },
          after: { cost: '120.00', costCurrency: 'USD' },
        },
      },
    });
  });

  it('el % de la pasarela del medio solo lo pone ADMIN, validado y auditado antes/después', async () => {
    await as(a, dentist.token)
      .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 3.5 })
      .expect(403);
    const bad = await as(a)
      .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 120 })
      .expect(400);
    expect((bad.body as { message: string }).message).toBe(
      GATEWAY_FEE_PERCENT_MESSAGE,
    );
    const saved = (
      await as(a)
        .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 3.5 })
        .expect(200)
    ).body as { gatewayFeePercent: number | null };
    expect(saved.gatewayFeePercent).toBe(3.5);
    // Sin cambio: sin evento nuevo.
    await as(a)
      .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 3.5 })
      .expect(200);
    const listed = (await as(a).get('/payment-methods').expect(200)).body as {
      id: string;
      gatewayFeePercent: number | null;
    }[];
    expect(listed.find((m) => m.id === cardMethod)?.gatewayFeePercent).toBe(
      3.5,
    );
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PAYMENT_METHOD',
        resourceId: cardMethod,
      },
      select: { action: true, metadata: true },
    });
    const fee = events.filter(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'PAYMENT_METHOD_GATEWAY_FEE_UPDATED',
    );
    expect(fee).toHaveLength(1);
    expect(fee[0].action).toBe('UPDATE');
    expect(JSON.stringify(fee[0].metadata)).toContain('3.5');
  });

  // ISOLATION_COVERS: PUT /lab-orders/:id/cost
  // ISOLATION_COVERS: PUT /payment-methods/:id/gateway-fee
  it('B → 404 al poner el costo de la orden de A o la comisión del medio de A, y A no cambia', async () => {
    await as(b)
      .put(`/lab-orders/${crownOrder}/cost`, { cost: '1', currency: 'USD' })
      .expect(404);
    await as(b)
      .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 50 })
      .expect(404);
    const order = await raw.dentalLabOrder.findUniqueOrThrow({
      where: { id: crownOrder },
      select: { cost: true, costCurrency: true },
    });
    expect(order.cost?.toString()).toBe('120');
    expect(order.costCurrency).toBe('USD');
    const method = await raw.clinicPaymentMethod.findUniqueOrThrow({
      where: { id: cardMethod },
      select: { gatewayFeePercent: true },
    });
    expect(method.gatewayFeePercent?.toNumber()).toBe(3.5);
  });

  it('la regla guarda los descuentos y la vista previa los aplica por abono (laboratorio en otra moneda: aviso, sin descontar)', async () => {
    const saved = await as(a)
      .put(`/commissions/rules/${dentist.userId}`, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 40,
        deductLabCost: true,
        deductCardFee: true,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      rule: { deductLabCost: true, deductCardFee: true },
    });
    payment = idOf(
      await as(a, receptionA)
        .post(`/treatment-plans/${planA}/payments`, {
          amount: 500,
          currency: 'USD',
          paidAt: '2026-09-15',
          method: 'CARD',
        })
        .expect(201),
    );

    const body = (await preview(SEPT).expect(200)).body as Preview;
    // Corona: 300 − laboratorio 120 − pasarela 3,5 % (10,50) = 169,50 → 40 % = 67,80.
    expect(lineOf(body.lines, crownItem)).toMatchObject({
      payment: { id: payment },
      base: 169.5,
      amount: 67.8,
      deductions: {
        grossBase: 300,
        labCost: 120,
        cardFeePercent: 3.5,
        cardFee: 10.5,
        labCostSkippedCurrencies: [],
      },
    });
    // Endodoncia: el laboratorio en VES no se descuenta; pasarela 7 → 193 → 77,20.
    expect(lineOf(body.lines, endoItem)).toMatchObject({
      base: 193,
      amount: 77.2,
      deductions: {
        grossBase: 200,
        labCost: 0,
        cardFee: 7,
        labCostSkippedCurrencies: ['VES'],
      },
    });
    expect(body.totals).toEqual([
      expect.objectContaining({ currency: 'USD', accrued: 145 }),
    ]);
    // El odontólogo ve lo que se le descontó en su propia vista previa.
    const own = (await preview(SEPT, dentist.token).expect(200))
      .body as Preview;
    expect(lineOf(own.lines, crownItem)?.deductions.labCost).toBe(120);
  });

  it('el cierre congela lo descontado; cambiar después costo, % o regla no lo mueve ni genera ajustes', async () => {
    septSettlement = (
      await as(a)
        .post('/commissions/settlements', { userId: dentist.userId, ...SEPT })
        .expect(201)
    ).body as Settlement;
    expect(septSettlement).toMatchObject({
      deductLabCost: true,
      deductCardFee: true,
    });
    expect(lineOf(septSettlement.lines, crownItem)).toMatchObject({
      base: 169.5,
      amount: 67.8,
      deductions: { grossBase: 300, labCost: 120, cardFee: 10.5 },
    });
    expect(
      lineOf(septSettlement.lines, endoItem)?.deductions
        .labCostSkippedCurrencies,
    ).toEqual(['VES']);

    await as(a)
      .put(`/lab-orders/${crownOrder}/cost`, { cost: '200', currency: 'USD' })
      .expect(200);
    await as(a)
      .put(`/payment-methods/${cardMethod}/gateway-fee`, { percent: 5 })
      .expect(200);
    await as(a)
      .put(`/commissions/rules/${dentist.userId}`, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 40,
      })
      .expect(200);

    const frozen = (
      await as(a)
        .get(`/commissions/settlements/${septSettlement.id}`)
        .expect(200)
    ).body as Settlement;
    expect(frozen.lines).toEqual(septSettlement.lines);
    expect(frozen.totals).toEqual(septSettlement.totals);
    expect(frozen.deductLabCost).toBe(true);
    const october = (await preview(OCT).expect(200)).body as Preview;
    expect(october.lines).toEqual([]);
  });

  it('abono anulado tras el cierre: el ajuste devuelve la base y lo descontado (la línea queda en 0)', async () => {
    await as(a)
      .patch('/clinic/settings/financial-lock', { adminExempt: true })
      .expect(200);
    await as(a)
      .delete(`/payments/${payment}`, {
        reason: 'Cobro con la tarjeta equivocada',
        lockOverrideReason: 'Anulación confirmada con el punto de venta',
      })
      .expect(200);
    const october = (await preview(OCT).expect(200)).body as Preview;
    const crownLine = lineOf(septSettlement.lines, crownItem)!;
    const adjustment = october.lines.find(
      (l) => l.kind === 'ADJUSTMENT' && l.adjustsLineId === crownLine.id,
    );
    expect(adjustment).toMatchObject({
      base: -169.5,
      amount: -67.8,
      percent: 40,
      deductions: {
        grossBase: -300,
        labCost: -120,
        cardFeePercent: 3.5,
        cardFee: -10.5,
      },
    });
    expect(october.totals).toEqual([
      expect.objectContaining({
        currency: 'USD',
        accrued: 0,
        adjustments: -145,
      }),
    ]);
  });
});
