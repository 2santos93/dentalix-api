import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-376 en HTTP real: el recibo de un abono en otra moneda trae la tasa que
// congeló el abono (DX-375), su fuente, su día y el equivalente en la moneda
// del plan. Dos abonos en VES a dos tasas distintas (ayer y hoy) sobre un plan
// en USD; reimprimir tras cambiar la tasa de ese día da lo mismo. Un abono
// «sin tasa» lo dice. EXCHANGE_APP_ID está vacío en .env.test: el proveedor
// no se llama nunca (hay snapshot de los dos días).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);
const YESTERDAY = addCivilDays(TODAY, -1);

interface ReceiptBody {
  exchangeRate: {
    status: string;
    rate: {
      currency: string;
      fromPerBase: number;
      toPerBase: number;
      source: string;
      date: string;
    } | null;
    equivalentAmount: number | null;
  } | null;
  snapshot: { payment: { amount: number; currency: string } };
}

describe('Recibo con la tasa congelada del abono (e2e, DX-376)', () => {
  let app: INestApplication<App>;
  let auto: Clinic;
  let manual: Clinic;
  const plans = new Map<string, string>();

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const pay = async (
    clinic: Clinic,
    amount: number,
    currency: string,
    paidAt: string,
  ): Promise<string> =>
    (
      (
        await as(
          api().post(
            `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/payments`,
          ),
          clinic,
        )
          .send({ amount, currency, paidAt, method: 'CASH' })
          .expect(201)
      ).body as { id: string }
    ).id;
  const receipt = async (
    clinic: Clinic,
    paymentId: string,
  ): Promise<ReceiptBody> =>
    (
      await as(
        api().get(`/api/v1/payments/${paymentId}/receipt`),
        clinic,
      ).expect(200)
    ).body as ReceiptBody;
  const reprint = async (
    clinic: Clinic,
    paymentId: string,
  ): Promise<ReceiptBody> =>
    (
      await as(
        api().post(`/api/v1/payments/${paymentId}/receipt/print`),
        clinic,
      ).expect(200)
    ).body as ReceiptBody;

  /** Paciente, ítem de 1.000 USD hecho y plan en USD. */
  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Recibo',
          docType: 'NATIONAL_ID',
          docNumber: `DX376-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX376-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
        )
          .send({ notes: 'Plan DX-376', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    plans.set(clinic.tenantId, planId);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });
    // Dos tasas distintas: 36,5 ayer y 40 hoy.
    await raw.exchangeRateSnapshot.createMany({
      data: [
        { date: YESTERDAY, currency: 'VES', rate: 36.5 },
        { date: TODAY, currency: 'VES', rate: 40 },
      ],
    });
    auto = await registerClinic(app, 'dx376-auto');
    manual = await registerClinic(app, 'dx376-manual');
    await seedPlan(auto, 'A');
    await seedPlan(manual, 'M');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });
    await app.close();
    await raw.$disconnect();
  });

  it('dos abonos en VES a tasas distintas imprimen cada uno su tasa, su fuente, su día y su equivalente en USD', async () => {
    const yesterday = await pay(auto, 1825, 'VES', YESTERDAY);
    const today = await pay(auto, 2000, 'VES', TODAY);

    await expect(receipt(auto, yesterday)).resolves.toMatchObject({
      snapshot: { payment: { amount: 1825, currency: 'VES' } },
      exchangeRate: {
        status: 'FROZEN',
        rate: {
          currency: 'USD',
          fromPerBase: 36.5,
          toPerBase: 1,
          source: 'AUTOMATIC',
          date: YESTERDAY,
        },
        equivalentAmount: 50,
      },
    });
    await expect(receipt(auto, today)).resolves.toMatchObject({
      exchangeRate: {
        status: 'FROZEN',
        rate: { fromPerBase: 40, source: 'AUTOMATIC', date: TODAY },
        equivalentAmount: 50,
      },
    });

    // La tasa de ayer cambia después: la reimpresión sigue con la congelada.
    await raw.exchangeRateSnapshot.updateMany({
      where: { date: YESTERDAY, currency: 'VES' },
      data: { rate: 50 },
    });
    await expect(reprint(auto, yesterday)).resolves.toMatchObject({
      exchangeRate: {
        rate: { fromPerBase: 36.5, date: YESTERDAY },
        equivalentAmount: 50,
      },
    });
  });

  it('un abono en la moneda del plan no trae tasa', async () => {
    const id = await pay(auto, 10, 'USD', TODAY);
    await expect(receipt(auto, id)).resolves.toMatchObject({
      exchangeRate: null,
    });
  });

  it('un abono «sin tasa» de su día lo dice, sin tasa ni equivalente', async () => {
    await as(api().put('/api/v1/exchange/settings'), manual)
      .send({ source: 'MANUAL' })
      .expect(200);
    const id = await pay(manual, 2000, 'VES', TODAY);
    await expect(receipt(manual, id)).resolves.toMatchObject({
      exchangeRate: { status: 'MISSING', rate: null, equivalentAmount: null },
    });
  });

  it('el recibo de otra clínica es 404: la tasa no se filtra entre clínicas', async () => {
    const id = await pay(auto, 365, 'VES', TODAY);
    await as(api().get(`/api/v1/payments/${id}/receipt`), manual).expect(404);
  });
});
