import { PaymentProofs } from '../src/modules/payments/application/payment-proofs';
import { PaymentProofUploads } from '../src/modules/payments/application/payment-proof-uploads';
import { InMemoryFileStorage } from '../src/shared/storage/__fixtures__/in-memory-file-storage';
import { BadRequestException } from '@nestjs/common';
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
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import type { ReceiptBalanceInTx } from '../src/modules/payments/domain/ports/payment-repository.port';
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
// El pool de Prisma por defecto es 2·CPUs+1 (5 en un runner de 2 vCPU de CI).
// Esta prueba mantiene abiertas a la vez las N transacciones (la barrera de
// dentro de la transacción las espera juntas, y todas menos una esperan el
// bloqueo del plan con su conexión), así que el pool tiene que ser mayor que N
// o la 6.ª ni siquiera empieza en `maxWait` (P2028). Es una condición de la
// PRUEBA, no del producto: en producción cada abono retiene su conexión
// milisegundos y, si el pool se agotara, la petición sale con el 503
// retryable `TRANSACTION_TIMEOUT` (PrismaExceptionFilter, DX-431).
const MAX_CONCURRENCY = 10;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = withConnectionLimit(
  ORIGINAL_DATABASE_URL ?? '',
  MAX_CONCURRENCY * 2,
);
// Prisma lee la variable al conectar, no al construir: se restaura en afterAll.
const prisma = new PrismaService(tenantContext);

function withConnectionLimit(url: string, limit: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
}
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
/** Sin tasa para ningún par de monedas distintas (p. ej. VES → USD ese día). */
const noRateReject = (input: { from: string; to: string }) =>
  input.from === input.to
    ? Promise.resolve({ ...input, result: 0, rateUsed: 1 })
    : Promise.reject(
        new BadRequestException(`unsupported currency: ${input.from}`),
      );
const noRateConvert = {
  execute: noRateReject,
  quote: noRateReject,
  memoized: () => ({ execute: noRateReject, quote: noRateReject }),
} as unknown as ConvertAmountUseCase;
const balance = new GetPlanBalanceUseCase(
  paymentRepo,
  getPlan,
  identityConvert,
  new PrismaPlanAllocationRepository(prisma, tenantContext),
);

/**
 * Segunda barrera, DENTRO de la transacción (tras el INSERT del abono y antes
 * de leer la foto del plan): ninguna sigue hasta que cada una de las N, o ha
 * llegado aquí, o espera a un bloqueo de otra (`pg_stat_activity`). Con el plan
 * FOR SHARE llegan las N a la vez y todas leen la misma foto (rojo seguro);
 * con FOR NO KEY UPDATE llega una y las demás esperan el bloqueo (verde). El
 * sondeo solo limita el intervalo; la condición de avance es el estado de la BD.
 */
class InTransactionBarrier {
  private arrived = 0;
  private readonly release = gate();
  private open = false;
  constructor(private readonly parties: number) {}

  wrap(inner: ReceiptBalanceInTx): ReceiptBalanceInTx {
    return async (data) => {
      this.arrived += 1;
      const deadline = Date.now() + 8000;
      while (!this.open) {
        const [row] = await owner.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (this.arrived + row.waiting >= this.parties) {
          this.open = true;
          this.release.open();
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('la barrera de la transacción no se completó');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await this.release.wait;
      return inner(data);
    };
  }
}

/**
 * La barrera de fuera: el saldo «de antes» se lee fuera de la transacción;
 * ningún abono sigue hasta que TODOS lo han leído (sin sleeps), que es el peor
 * intercalado del cobro con el saldo calculado fuera. Y la de dentro.
 */
class BarrierBalance extends ReceiptPlanBalanceCalculator {
  private arrived = 0;
  private release = gate();
  constructor(private readonly parties: number) {
    super(balance);
    const inner = this.inTransaction;
    const inside = new InTransactionBarrier(parties);
    (this as { inTransaction: ReceiptBalanceInTx }).inTransaction =
      inside.wrap(inner);
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
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
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
        new PaymentProofs(
          new PaymentProofUploads(
            new InMemoryFileStorage(),
            tenantContext,
            900,
          ),
          paymentRepo,
        ),
        () => NOW,
      );
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
    const inside = new InTransactionBarrier(3);
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
            receiptBalanceInTx: inside.wrap(calculator.inTransaction),
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

  describe('abono sin tasa de su día (VES en un plan en USD)', () => {
    it('suelto: el abono no cuenta en el saldo, así que el recibo sale SIN saldo', async () => {
      const planId = await seedPlan();
      const recordPayment = new RecordPaymentUseCase(
        paymentRepo,
        getPlan,
        whitelist,
        new ReceiptPlanBalanceCalculator(balance),
        noRateConvert,
        new PaymentMethodGate(
          new PrismaPaymentMethodRepository(prisma, tenantContext),
          paymentRepo,
          referenceCurrencyDigitsCatalog(),
        ),
        new PaymentProofs(
          new PaymentProofUploads(
            new InMemoryFileStorage(),
            tenantContext,
            900,
          ),
          paymentRepo,
        ),
        () => NOW,
      );
      const payment = await inTenant(() =>
        recordPayment.execute(planId, {
          amount: 100000,
          currency: 'VES',
          paidAt: '2026-10-16',
        }),
      );
      expect(payment.receiptNumber).toBeTruthy();
      expect(await receiptBalances(planId)).toEqual([null]);
    });

    it('dividido: con una línea en VES sin tasa, el recibo único sale SIN saldo', async () => {
      const planId = await seedPlan();
      const base = {
        treatmentPlanId: planId,
        patientId,
        paidAt: NOW,
        method: 'CASH' as const,
        createdById: userId,
        receiptPlanBalance: null,
        frozenRate: null,
      };
      await inTenant(() =>
        paymentRepo.createSplit({
          lines: [
            {
              ...base,
              amount: 50,
              currency: 'USD',
              planAmount: {
                planCurrency: 'USD',
                amount: 50,
                rateDate: '2026-10-16',
              },
            },
            {
              ...base,
              amount: 100000,
              currency: 'VES',
              planAmount: null,
            },
          ],
          receiptPlanBalance: null,
          receiptBalanceInTx: new ReceiptPlanBalanceCalculator(balance)
            .inTransaction,
        }),
      );
      expect(await receiptBalances(planId)).toEqual([null]);
    });
  });

  // El INSERT de `payments` ya serializa los abonos de un mismo paciente (el
  // disparador de `patient_ledgers` actualiza una fila por paciente), así que
  // las pruebas de arriba no distinguen FOR SHARE de FOR NO KEY UPDATE en el
  // plan. Esta sí: un titular de FOR SHARE sobre el plan (como el reparto, el
  // barrido o la reasignación) hace ESPERAR al abono. Con FOR SHARE en el
  // repositorio el abono no espera y la prueba da rojo.
  it('el abono bloquea el plan en exclusiva frente a quien lo tiene FOR SHARE', async () => {
    const planId = await seedPlan();
    const holding = gate();
    const held = gate<string>();
    const holder = owner.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR SHARE`;
      held.open(await transactionId(tx));
      await holding.wait;
    });
    const xid = await held.wait;
    const pending = settle(
      inTenant(() =>
        paymentRepo.create({
          treatmentPlanId: planId,
          patientId,
          amount: CHUNK,
          currency: 'USD',
          paidAt: NOW,
          receiptPlanBalance: null,
          planAmount: null,
          frozenRate: null,
        }),
      ),
    );
    try {
      await waitForTransactionWaiters(owner, xid);
    } finally {
      holding.open();
      await holder;
    }
    expect((await pending).status).toBe('fulfilled');
  });
});
