import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { referenceCurrencyDigitsCatalog } from '../src/shared/money/__fixtures__/reference-currency-digits';
import { PaymentMethodGate } from '../src/modules/payments/application/payment-method-gate';
import { PrismaPaymentMethodRepository } from '../src/modules/payment-methods/infrastructure/prisma-payment-method.repository';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { GetTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { ReceiptPlanBalanceCalculator } from '../src/modules/payments/application/receipts/receipt-plan-balance';
import { RecordPaymentUseCase } from '../src/modules/payments/application/use-cases/record-payment.use-case';
import { GetPlanBalanceUseCase } from '../src/modules/payments/application/use-cases/get-plan-balance.use-case';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import type { CurrencyWhitelist } from '../src/modules/treatment-plans/domain/ports/currency-whitelist.port';
import { gate } from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-182: el saldo impreso en cada recibo es el del plan TRAS SU abono, en el
// orden en que se registraron, aunque varios abonos al mismo plan lleguen a la
// vez. Contra Postgres real y con el caso de uso de verdad; `owner` solo
// siembra, lee sin RLS y limpia.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const planRepo = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const paymentRepo = new PrismaPaymentRepository(prisma, tenantContext);
const whitelist: CurrencyWhitelist = { has: () => Promise.resolve(true) };
const NOW = new Date('2026-10-16T15:00:00.000Z');
const getPlan = new GetTreatmentPlanUseCase(planRepo);
const identityExecute = (input: { amount: number }) =>
  Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
const identityQuote = (input: { from: string; to: string; date: string }) =>
  Promise.resolve({
    ...input,
    source: 'AUTOMATIC',
    fromPerBase: 1,
    toPerBase: 1,
  });
const identityConvert = {
  execute: identityExecute,
  quote: identityQuote,
  memoized: () => ({ execute: identityExecute, quote: identityQuote }),
} as unknown as ConvertAmountUseCase;
const balance = new GetPlanBalanceUseCase(
  paymentRepo,
  getPlan,
  identityConvert,
  new PrismaPlanAllocationRepository(prisma, tenantContext),
);

/**
 * La barrera determinista: el saldo «de antes» se lee fuera de la transacción;
 * ningún abono sigue hasta que TODOS lo han leído (sin sleeps), que es el peor
 * intercalado posible del cobro.
 */
class BarrierBalance extends ReceiptPlanBalanceCalculator {
  private arrived = 0;
  private release = gate();
  constructor(private readonly parties: number) {
    super(balance);
  }
  rearm(): void {
    this.arrived = 0;
    this.release = gate();
  }
  override async afterPayment(
    ...args: Parameters<ReceiptPlanBalanceCalculator['afterPayment']>
  ) {
    const result = await super.afterPayment(...args);
    if (++this.arrived === this.parties) this.release.open();
    await this.release.wait;
    return result;
  }
}

const SUBDOMAIN = 'dx182-int';
const BILLABLE = 1000;
const CHUNK = 100;

describe('DX-182 · saldo exacto en el recibo con abonos concurrentes (int)', () => {
  let tenantId: string;
  let userId: string;
  let patientId: string;
  let catalogItemId: string;

  const inTenant = <T>(fn: () => Promise<T>) =>
    tenantContext.run(tenantId, undefined, fn);

  async function purge(): Promise<void> {
    const tenants = await owner.tenant.findMany({
      where: { subdomain: SUBDOMAIN },
      select: { id: true },
    });
    const where = { tenantId: { in: tenants.map((t) => t.id) } };
    await owner.paymentReceipt.deleteMany({ where });
    await owner.paymentReceiptCounter.deleteMany({ where });
    await owner.paymentAllocation.deleteMany({ where });
    await owner.paymentAllocationMovement.deleteMany({ where });
    await owner.paymentPlanAmount.deleteMany({ where });
    await owner.planAllocationRebalanceRequest.deleteMany({ where });
    await owner.payment.deleteMany({ where });
    await owner.treatmentPlanItem.deleteMany({ where });
    await owner.treatmentPlan.deleteMany({ where });
    await owner.dentalCatalogItem.deleteMany({ where });
    await owner.patient.deleteMany({ where });
    await owner.location.deleteMany({ where });
    await owner.tenant.deleteMany({
      where: { id: { in: tenants.map((t) => t.id) } },
    });
    await owner.user.deleteMany({
      where: { email: `${SUBDOMAIN}@example.com` },
    });
  }

  async function seedPlan(): Promise<string> {
    const plan = await owner.treatmentPlan.create({
      data: {
        tenantId,
        patientId,
        currency: 'USD',
        createdById: userId,
        status: TreatmentPlanStatus.ACCEPTED,
      },
    });
    await owner.treatmentPlanItem.create({
      data: {
        tenantId,
        planId: plan.id,
        catalogItemId,
        toothNumber: '11',
        price: BILLABLE,
        discount: 0,
        status: 'ACCEPTED',
      },
    });
    return plan.id;
  }

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    tenantId = (
      await owner.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    userId = (
      await owner.user.create({
        data: {
          email: `${SUBDOMAIN}@example.com`,
          passwordHash: 'x',
          fullName: 'Recepción DX-182',
        },
      })
    ).id;
    await owner.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name: 'Sede',
      }),
    });
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Saldo' },
      })
    ).id;
    catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'dx182',
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  /** Los saldos impresos en los recibos del plan, en el orden de registro. */
  async function receiptBalances(planId: string) {
    const payments = await owner.payment.findMany({
      where: { treatmentPlanId: planId },
      include: { receipt: true },
      orderBy: { createdAt: 'asc' },
    });
    const byNumber = payments
      .filter((p) => p.receipt !== null)
      .map((p) => ({
        number: p.receipt!.number,
        snapshot: p.receipt!.snapshot as unknown as {
          planBalance: { paid: number; balance: number } | null;
        },
      }))
      .sort((x, y) => x.number - y.number);
    return byNumber.map((r) => r.snapshot.planBalance);
  }

  it.each([2, 10])(
    '%i abonos simultáneos al mismo plan: cada recibo muestra el saldo tras SU abono',
    async (count) => {
      const planId = await seedPlan();
      const calculator = new BarrierBalance(count);
      const recordPayment = new RecordPaymentUseCase(
        paymentRepo,
        getPlan,
        whitelist,
        calculator,
        identityConvert,
        new PaymentMethodGate(
          new PrismaPaymentMethodRepository(prisma, tenantContext),
          paymentRepo,
          referenceCurrencyDigitsCatalog(),
        ),
        () => NOW,
      );
      calculator.rearm();
      await Promise.all(
        Array.from({ length: count }, () =>
          inTenant(() =>
            recordPayment.execute(planId, {
              amount: CHUNK,
              currency: 'USD',
              paidAt: '2026-10-16',
            }),
          ),
        ),
      );

      const printed = await receiptBalances(planId);
      expect(printed).toHaveLength(count);
      // El k-ésimo recibo (por número) dice: pagado k·100, saldo 1000 − k·100.
      expect(printed.map((b) => b?.paid)).toEqual(
        Array.from({ length: count }, (_, k) => CHUNK * (k + 1)),
      );
      expect(printed.map((b) => b?.balance)).toEqual(
        Array.from({ length: count }, (_, k) => BILLABLE - CHUNK * (k + 1)),
      );
      // Y el último coincide con el saldo del plan.
      const final = await inTenant(() => balance.execute(planId));
      expect(printed[count - 1]?.balance).toBe(final.balance);
    },
  );

  it('cobros divididos simultáneos al mismo plan: el recibo de cada uno suma las líneas anteriores y las suyas', async () => {
    const planId = await seedPlan();
    const calculator = new ReceiptPlanBalanceCalculator(balance);
    const line = {
      treatmentPlanId: planId,
      patientId,
      amount: CHUNK / 2,
      currency: 'USD',
      paidAt: NOW,
      method: 'CASH' as const,
      createdById: userId,
      receiptPlanBalance: null,
      planAmount: {
        planCurrency: 'USD',
        amount: CHUNK / 2,
        rateDate: '2026-10-16',
      },
      frozenRate: null,
    };
    await Promise.all(
      Array.from({ length: 3 }, () =>
        inTenant(() =>
          paymentRepo.createSplit({
            lines: [line, line],
            receiptPlanBalance: null,
            receiptBalanceInTx: calculator.inTransaction,
          }),
        ),
      ),
    );
    const printed = await receiptBalances(planId);
    // Un recibo por cobro (línea 1); sus saldos van 900, 800, 700.
    expect(printed.map((b) => b?.balance)).toEqual([
      BILLABLE - CHUNK,
      BILLABLE - 2 * CHUNK,
      BILLABLE - 3 * CHUNK,
    ]);
  });
});
