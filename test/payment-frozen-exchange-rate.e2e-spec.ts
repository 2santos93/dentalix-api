import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { MANUAL_RATE_IN_USE_MESSAGE } from '../src/modules/exchange/domain/exchange-rate-source';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { addCivilDays } from '../src/shared/time/civil-day';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { fixedSedeDay } from './support/sede-clock';

// DX-375 en HTTP real: cada abono congela la tasa que usó y su fuente. Dos
// clínicas el MISMO día, una automática y otra manual, congelan cada una la
// suya; cambiar la tasa después no mueve saldos; sin tasa del día el abono
// se guarda «sin tasa» y el saldo lo dice; una tasa manual usada responde 409
// y una sin usar se corrige (auditado); y cambiar la fuente no mueve ningún
// abono ya cobrado, tampoco uno de hoy anterior al cambio ni uno anterior a
// DX-375 (BE-047). EXCHANGE_APP_ID está vacío en .env.test: el proveedor no
// se llama nunca (hay snapshot de los dos días).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/**
 * «Hoy» FIJO de las dos clínicas: el día anterior al real, a mediodía de la
 * sede, que la API ve por su EXCHANGE_RATE_CLOCK. Los abonos «de hace un
 * momento» son de ese mediodía: ninguno cae en «ayer» aunque la suite cruce
 * la medianoche de Bogotá (DX-209, TST-049).
 */
const SEDE_DAY = fixedSedeDay();
const TODAY = SEDE_DAY.day;
const YESTERDAY = addCivilDays(TODAY, -1);
const PROVIDER = { COP: 4000, VES: 36.5 };
const SETTINGS = '/api/v1/exchange/settings';
const MANUAL_RATES = '/api/v1/exchange/manual-rates';

interface PaymentBody {
  id: string;
  exchangeRateStatus: string;
  exchangeRateCurrency: string | null;
  frozenRate: {
    currency: string;
    fromPerBase: number;
    toPerBase: number;
    source: string;
    date: string;
  } | null;
}

interface BalanceBody {
  billable: number;
  paid: number;
  balance: number;
  paymentsCount: number;
  paymentsWithoutRate: {
    paymentId: string;
    amount: number;
    currency: string;
    paidOn: string;
  }[];
  allocated: number;
  unallocated: number;
}

interface ManualRateBody {
  id: string;
  date: string;
  currency: string;
  rate: number;
  inUse: boolean;
}

describe('Tasa congelada en cada abono (e2e, DX-375)', () => {
  let app: INestApplication<App>;
  let auto: Clinic;
  let manual: Clinic;
  const plans = new Map<string, string>();

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const balance = async (clinic: Clinic): Promise<BalanceBody> =>
    (
      await as(
        api().get(
          `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/balance`,
        ),
        clinic,
      ).expect(200)
    ).body as BalanceBody;
  const pay = async (
    clinic: Clinic,
    amount: number,
    paidAt: string,
    currency = 'COP',
  ): Promise<PaymentBody> =>
    (
      await as(
        api().post(
          `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/payments`,
        ),
        clinic,
      )
        .send({ amount, currency, paidAt, method: 'CASH' })
        .expect(201)
    ).body as PaymentBody;
  const setSource = (clinic: Clinic, source: 'AUTOMATIC' | 'MANUAL') =>
    as(api().put(SETTINGS), clinic).send({ source }).expect(200);
  const registerRate = async (
    clinic: Clinic,
    body: { date: string; currency: string; rate: number },
  ): Promise<ManualRateBody> =>
    (await as(api().post(MANUAL_RATES), clinic).send(body).expect(201))
      .body as ManualRateBody;
  const listRates = async (clinic: Clinic): Promise<ManualRateBody[]> =>
    (await as(api().get(MANUAL_RATES), clinic).expect(200))
      .body as ManualRateBody[];

  /** Paciente, ítem de 1.000 USD hecho y plan en USD. */
  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Congelada',
          docType: 'NATIONAL_ID',
          docNumber: `DX375-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX375-${tag}`,
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
          .send({ notes: 'Plan DX-375', currency: 'USD' })
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
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_CLOCK)
          .useValue(() => SEDE_DAY.at),
    });
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: [YESTERDAY, TODAY].flatMap((date) =>
        Object.entries(PROVIDER).map(([currency, rate]) => ({
          date,
          currency,
          rate,
        })),
      ),
    });
    auto = await registerClinic(app, 'dx375-auto');
    manual = await registerClinic(app, 'dx375-manual');
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

  it('BE-047: un abono de hoy cobrado antes de pasar a MANUAL conserva su tasa automática', async () => {
    // 40.000 COP a 4.000 = 10 USD, hoy, todavía en AUTOMATIC.
    const before = await pay(manual, 40000, SEDE_DAY.before(60).toISOString());
    expect(before).toMatchObject({
      exchangeRateStatus: 'FROZEN',
      exchangeRateCurrency: 'USD',
      frozenRate: {
        currency: 'USD',
        fromPerBase: 4000,
        toPerBase: 1,
        source: 'AUTOMATIC',
        date: TODAY,
      },
    });
    // Un abono anterior a DX-375 (columnas NULL), de ayer: se leía en vivo.
    const legacy = await pay(manual, 80000, `${YESTERDAY}T15:00:00.000Z`);
    await raw.payment.update({
      where: { id: legacy.id },
      data: {
        exchangeRateCurrency: null,
        exchangeRateFrom: null,
        exchangeRateTo: null,
        exchangeRateSource: null,
        exchangeRateDate: null,
      },
    });
    await expect(balance(manual)).resolves.toMatchObject({ paid: 30 });

    await setSource(manual, 'MANUAL');

    // Sin ninguna tasa manual registrada, los dos siguen igual.
    await expect(balance(manual)).resolves.toMatchObject({
      paid: 30,
      paymentsWithoutRate: [],
    });
    const frozenLegacy = await raw.payment.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { exchangeRateSource: true, exchangeRateFrom: true },
    });
    expect(frozenLegacy.exchangeRateSource).toBe('AUTOMATIC');
    expect(Number(frozenLegacy.exchangeRateFrom)).toBe(4000);
  });

  it('sin tasa manual del día el abono se guarda «sin tasa» y el saldo lo dice', async () => {
    const missing = await pay(manual, 41000, SEDE_DAY.before(30).toISOString());
    expect(missing).toMatchObject({
      exchangeRateStatus: 'MISSING',
      exchangeRateCurrency: 'USD',
      frozenRate: null,
    });
    await expect(balance(manual)).resolves.toMatchObject({
      paid: 30,
      paymentsCount: 3,
      paymentsWithoutRate: [
        {
          paymentId: missing.id,
          amount: 41000,
          currency: 'COP',
          paidOn: TODAY,
        },
      ],
    });
  });

  it('dos clínicas el mismo día con fuentes distintas congelan cada una su tasa', async () => {
    await registerRate(manual, { date: TODAY, currency: 'COP', rate: 4100 });
    // El barrido congela el «sin tasa» con la manual: 41.000 / 4.100 = 10.
    await app.get(PaymentAllocationJobs).sweep();
    await expect(balance(manual)).resolves.toMatchObject({
      paid: 40,
      paymentsWithoutRate: [],
    });
    const viaManual = await pay(
      manual,
      41000,
      SEDE_DAY.before(20).toISOString(),
    );
    const viaAuto = await pay(auto, 41000, SEDE_DAY.before(20).toISOString());
    expect(viaManual.frozenRate).toMatchObject({
      source: 'MANUAL',
      fromPerBase: 4100,
      date: TODAY,
    });
    expect(viaAuto.frozenRate).toMatchObject({
      source: 'AUTOMATIC',
      fromPerBase: 4000,
      date: TODAY,
    });
    await expect(balance(manual)).resolves.toMatchObject({ paid: 50 });
    // 41.000 / 4.000 = 10,25.
    await expect(balance(auto)).resolves.toMatchObject({ paid: 10.25 });
  });

  it('una tasa manual usada responde 409 en español al cambiarla y no cambia el saldo', async () => {
    const [cop] = (await listRates(manual)).filter((r) => r.currency === 'COP');
    expect(cop).toMatchObject({ date: TODAY, inUse: true });
    const res = await as(api().put(`${MANUAL_RATES}/${cop.id}`), manual)
      .send({ rate: 4500 })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'MANUAL_EXCHANGE_RATE_IN_USE',
      message: MANUAL_RATE_IN_USE_MESSAGE,
    });
    await expect(balance(manual)).resolves.toMatchObject({ paid: 50 });
  });

  // ISOLATION_COVERS: PUT /exchange/manual-rates/:id
  it('una tasa manual sin usar se corrige y queda en la auditoría', async () => {
    const ves = await registerRate(manual, {
      date: TODAY,
      currency: 'VES',
      rate: 40,
    });
    expect(ves.inUse).toBe(false);
    await as(api().put(`${MANUAL_RATES}/${ves.id}`), manual)
      .send({ rate: 40.5 })
      .expect(200)
      .expect((r) => {
        expect(r.body).toMatchObject({ rate: 40.5, inUse: false });
      });
    const audit = (
      await as(
        api().get('/api/v1/audit-events?resourceType=EXCHANGE_RATE'),
        manual,
      ).expect(200)
    ).body as { items: { action: string; resourceId: string }[] };
    expect(audit.items).toContainEqual(
      expect.objectContaining({ action: 'UPDATE', resourceId: ves.id }),
    );
    // De otra clínica: 404.
    await as(api().put(`${MANUAL_RATES}/${ves.id}`), auto)
      .send({ rate: 41 })
      .expect(404);
  });

  it('volver a AUTOMATIC no mueve ningún abono congelado con la manual', async () => {
    await setSource(manual, 'AUTOMATIC');
    await app.get(PaymentAllocationJobs).sweep();
    await expect(balance(manual)).resolves.toMatchObject({
      paid: 50,
      paymentsWithoutRate: [],
    });
  });

  it('el desglose por ítem cuadra con lo cobrado (BE-050)', async () => {
    await app.get(PaymentAllocationJobs).sweep();
    const b = await balance(manual);
    expect(b.allocated + b.unallocated).toBeCloseTo(b.paid, 2);
  });
});
