import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCurrencyDigitsCatalog } from '../src/shared/money/prisma-currency-digits.catalog';
import { PrismaReceivablesRepository } from '../src/modules/receivables/infrastructure/prisma-receivables.repository';
import {
  GetReceivablesAgingUseCase,
  type AgingTotal,
} from '../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';
import { planBalanceWithoutLiveRates } from '../src/modules/payments/application/__fixtures__/plan-balance-without-live-rates';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

/**
 * OPS-056 · el recuento de cartera de «Mi día» (`summary`) contra la cartera
 * entera (`execute`, la de GET /receivables/aging/summary) sobre los MISMOS
 * datos en Postgres, como `dentalix_app` bajo RLS: dos sedes, tres monedas,
 * cuotas que aún no vencen, un paciente sin deuda, uno solo con saldo a favor
 * y un deudor con saldo a favor en otra moneda. Una segunda clínica con
 * deudas nunca cuenta.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const SUBDOMAINS = ['ops056-cartera-a', 'ops056-cartera-b'];
const DAY_MS = 86_400_000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

const aging = new GetReceivablesAgingUseCase(
  new PrismaReceivablesRepository(prisma, tenantContext),
  () => NOW,
  planBalanceWithoutLiveRates(),
  new PrismaCurrencyDigitsCatalog(prisma),
);

/** El número de «Mi día»: el mayor de los pacientes de cada moneda. */
const countOf = (totals: AgingTotal[]) =>
  totals.reduce((max, t) => Math.max(max, t.patients), 0);

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.installment.deleteMany({ where });
  await raw.paymentPlan.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

/** Siembra por `raw` (owner): los triggers mantienen `patient_ledgers`. */
class Clinic {
  private catalogId = '';

  constructor(
    readonly tenantId: string,
    readonly sedes: string[],
  ) {}

  static async create(subdomain: string, sedes: number): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const ids: string[] = [];
    for (let i = 0; i < sedes; i++) {
      const location = await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: tenant.id,
          name: `Sede ${i + 1}`,
          country: 'VE',
        }),
      });
      ids.push(location.id);
    }
    const clinic = new Clinic(tenant.id, ids);
    clinic.catalogId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: tenant.id,
          code: `ops056-${tenant.id.slice(0, 8)}`,
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        },
      })
    ).id;
    return clinic;
  }

  async patient(lastName: string): Promise<string> {
    return (
      await raw.patient.create({
        data: { tenantId: this.tenantId, firstName: 'Paciente', lastName },
      })
    ).id;
  }

  /** Plan aceptado y presentado en `locationId` hace `ageDays` días. */
  async plan(input: {
    patientId: string;
    locationId: string;
    currency: string;
    price: number;
    ageDays: number;
  }): Promise<string> {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: this.tenantId,
        patientId: input.patientId,
        currency: input.currency,
        status: 'ACCEPTED',
        presentedAt: daysAgo(input.ageDays),
        presentedLocationId: input.locationId,
      },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: this.tenantId,
        planId: plan.id,
        toothNumber: '16',
        catalogItemId: this.catalogId,
        price: input.price,
        status: 'ACCEPTED',
      },
    });
    return plan.id;
  }

  async pay(input: {
    planId: string;
    patientId: string;
    locationId: string;
    currency: string;
    amount: number;
  }): Promise<void> {
    await raw.payment.create({
      data: {
        tenantId: this.tenantId,
        treatmentPlanId: input.planId,
        patientId: input.patientId,
        locationId: input.locationId,
        currency: input.currency,
        amount: input.amount,
        paidAt: daysAgo(5),
      },
    });
  }

  /** Tres cuotas mensuales: una vencida y dos por vencer. */
  async installments(input: {
    planId: string;
    patientId: string;
    currency: string;
    amount: number;
  }): Promise<void> {
    const plan = await raw.paymentPlan.create({
      data: {
        tenantId: this.tenantId,
        treatmentPlanId: input.planId,
        patientId: input.patientId,
        currency: input.currency,
        totalToFinance: input.amount * 3,
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: daysAgo(40),
      },
    });
    for (const [sequence, dueDate] of [
      daysAgo(10),
      new Date(NOW.getTime() + 20 * DAY_MS),
      new Date(NOW.getTime() + 50 * DAY_MS),
    ].entries()) {
      await raw.installment.create({
        data: {
          tenantId: this.tenantId,
          paymentPlanId: plan.id,
          sequence: sequence + 1,
          dueDate,
          amount: input.amount,
        },
      });
    }
  }
}

describe('OPS-056 · recuento de cartera de «Mi día» = el de la cartera (int)', () => {
  let a: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await Clinic.create(SUBDOMAINS[0], 2);
    const [sede1, sede2] = a.sedes;

    // Sede 1 — deuda en USD, sin abonos (más de 30 días).
    const usd = await a.patient('Dólares');
    await a.plan({
      patientId: usd,
      locationId: sede1,
      currency: 'USD',
      price: 100,
      ageDays: 40,
    });
    // Sede 1 — deuda en VES con abono parcial, y saldo A FAVOR en USD: cuenta
    // en los pacientes de USD aunque ahí no deba.
    const mixto = await a.patient('Mixto');
    const ves = await a.plan({
      patientId: mixto,
      locationId: sede1,
      currency: 'VES',
      price: 500,
      ageDays: 70,
    });
    await a.pay({
      planId: ves,
      patientId: mixto,
      locationId: sede1,
      currency: 'VES',
      amount: 200,
    });
    const favor = await a.plan({
      patientId: mixto,
      locationId: sede1,
      currency: 'USD',
      price: 50,
      ageDays: 70,
    });
    await a.pay({
      planId: favor,
      patientId: mixto,
      locationId: sede1,
      currency: 'USD',
      amount: 80,
    });
    // Sede 1 — todo pagado: no es deudor.
    const alDia = await a.patient('Al día');
    const pagado = await a.plan({
      patientId: alDia,
      locationId: sede1,
      currency: 'USD',
      price: 70,
      ageDays: 20,
    });
    await a.pay({
      planId: pagado,
      patientId: alDia,
      locationId: sede1,
      currency: 'USD',
      amount: 70,
    });
    // Sede 2 — USD en cuotas (una vencida, dos por vencer) con abono parcial.
    const cuotas = await a.patient('Cuotas');
    const financiado = await a.plan({
      patientId: cuotas,
      locationId: sede2,
      currency: 'USD',
      price: 300,
      ageDays: 45,
    });
    await a.installments({
      planId: financiado,
      patientId: cuotas,
      currency: 'USD',
      amount: 100,
    });
    await a.pay({
      planId: financiado,
      patientId: cuotas,
      locationId: sede2,
      currency: 'USD',
      amount: 30,
    });
    // Sede 2 — solo saldo a favor: no es deudor.
    const soloFavor = await a.patient('Solo a favor');
    const pagadoDeMas = await a.plan({
      patientId: soloFavor,
      locationId: sede2,
      currency: 'USD',
      price: 40,
      ageDays: 15,
    });
    await a.pay({
      planId: pagadoDeMas,
      patientId: soloFavor,
      locationId: sede2,
      currency: 'USD',
      amount: 100,
    });
    // Sede 2 — tercera moneda, más de 90 días.
    const euros = await a.patient('Euros');
    await a.plan({
      patientId: euros,
      locationId: sede2,
      currency: 'EUR',
      price: 30,
      ageDays: 120,
    });

    // Otra clínica con deudas: nunca entra en las cuentas de A.
    const b = await Clinic.create(SUBDOMAINS[1], 1);
    for (let i = 0; i < 4; i++) {
      await b.plan({
        patientId: await b.patient(`B-${i}`),
        locationId: b.sedes[0],
        currency: 'USD',
        price: 999,
        ageDays: 100,
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  /** `summary` y la cartera entera en el mismo alcance. */
  async function both(scope: { activeLocation?: number; allowed?: number[] }) {
    const locationId =
      scope.activeLocation === undefined
        ? undefined
        : a.sedes[scope.activeLocation];
    const allowed = scope.allowed?.map((i) => a.sedes[i]);
    return tenantContext.run(
      a.tenantId,
      locationId,
      async () => ({
        summary: await aging.summary({ locationId }),
        page: await aging.execute({ locationId, page: 1, pageSize: 1 }),
      }),
      allowed,
    );
  }

  // El número es el mayor por moneda (USD: 3), nunca los 4 deudores sumados.
  it.each([
    ['toda la clínica', {}, 3],
    ['sede 1', { activeLocation: 0 }, 2],
    ['sede 2', { activeLocation: 1 }, 1],
    ['sin sede activa, solo la sede 2 permitida', { allowed: [1] }, 1],
    ['sin sede activa, ninguna permitida', { allowed: [] }, 0],
  ])('%s: los mismos totales y el mismo número', async (_, scope, expected) => {
    const { summary, page } = await both(scope);
    expect(summary.totals).toEqual(page.totals);
    expect(countOf(summary.totals)).toBe(countOf(page.totals));
    expect(countOf(summary.totals)).toBe(expected);
  });

  it('los datos ejercen lo que importa: tres monedas, a favor y cuotas por vencer', async () => {
    const { summary } = await both({});
    const byCurrency = new Map(summary.totals.map((t) => [t.currency, t]));
    expect([...byCurrency.keys()]).toEqual(['EUR', 'USD', 'VES']);
    // USD: el de USD, el de cuotas y el mixto (solo a favor en USD).
    expect(byCurrency.get('USD')).toMatchObject({ patients: 3, credit: 30 });
    expect(byCurrency.get('USD')!.buckets.current).toBeGreaterThan(0);
    expect(byCurrency.get('VES')).toMatchObject({ patients: 1, debt: 300 });
    expect(byCurrency.get('EUR')!.buckets.over90).toBe(30);
  });
});
