import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { GetPlanBalanceUseCase } from '../src/modules/payments/application/use-cases/get-plan-balance.use-case';
import { GetTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import type { PlanBalanceSnapshot } from '../src/modules/payments/domain/ports/plan-allocation-repository.port';
import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import type {
  CreatePaymentRepoInput,
  CreateSplitPaymentRepoInput,
  SplitPaymentRecord,
} from '../src/modules/payments/domain/ports/payment-repository.port';
import { parseReceiptSnapshot } from '../src/modules/payments/domain/receipt-snapshot';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  holdLock,
  settle,
  type Outcome,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-390: el cobro dividido contra Postgres real. Las líneas se registran con
// el repositorio de la API (rol dentalix_app, RLS) en UNA transacción: si una
// falla (aquí, la FK compuesta del medio de otra clínica), no queda ninguna,
// ni recibo, ni número gastado. `raw` (DIRECT_URL) solo siembra, lee sin RLS
// y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const payments = new PrismaPaymentRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx390-int-a', 'dx390-int-b'];

interface Clinic {
  tenantId: string;
  userId: string;
  locationId: string;
  patientId: string;
  planId: string;
  methodId: string;
}

let a: Clinic;
let b: Clinic;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: `Clínica ${subdomain}`, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: 'Recepción Prueba',
    },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
      address: 'Calle 1',
    }),
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Carolina',
      lastName: 'Duque',
      docNumber: `39${subdomain.length}0345678`,
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'USD',
      status: TreatmentPlanStatus.ACCEPTED,
    },
  });
  const method = await raw.clinicPaymentMethod.create({
    data: {
      id: randomUUID(),
      tenantId: tenant.id,
      name: 'Transferencia',
      kind: 'TRANSFER',
      updatedAt: new Date(),
    },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    locationId: location.id,
    patientId: patient.id,
    planId: plan.id,
    methodId: method.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const tenantId = { in: ids };
  await raw.treatmentPlanItem.deleteMany({ where: { tenantId } });
  await raw.dentalCatalogItem.deleteMany({ where: { tenantId } });
  await raw.patientCreditEntry.deleteMany({ where: { tenantId } });
  await raw.patientCreditTransfer.deleteMany({ where: { tenantId } });
  await raw.paymentReceipt.deleteMany({ where: { tenantId } });
  await raw.paymentReceiptCounter.deleteMany({ where: { tenantId } });
  await raw.paymentAllocation.deleteMany({ where: { tenantId } });
  await raw.paymentAllocationMovement.deleteMany({ where: { tenantId } });
  await raw.paymentPlanAmount.deleteMany({ where: { tenantId } });
  await raw.paymentBaseRetry.deleteMany({ where: { tenantId } });
  // Las líneas apuntan a su línea 1 (FK RESTRICT): primero las demás.
  await raw.payment.deleteMany({
    where: { tenantId, splitLine: { gt: 1 } },
  });
  await raw.payment.deleteMany({ where: { tenantId } });
  await raw.clinicPaymentMethod.deleteMany({ where: { tenantId } });
  await raw.treatmentPlan.deleteMany({ where: { tenantId } });
  await raw.patient.deleteMany({ where: { tenantId } });
  await raw.location.deleteMany({ where: { tenantId } });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `${s}@example.com`) } },
  });
}

function line(
  clinic: Clinic,
  overrides: Partial<CreatePaymentRepoInput> = {},
): CreatePaymentRepoInput {
  return {
    treatmentPlanId: clinic.planId,
    patientId: clinic.patientId,
    amount: 100_000,
    currency: 'USD',
    paidAt: new Date('2026-10-30T15:00:00.000Z'),
    method: 'TRANSFER',
    paymentMethodId: clinic.methodId,
    createdById: clinic.userId,
    receiptPlanBalance: null,
    planAmount: null,
    frozenRate: null,
    ...overrides,
  };
}

function split(
  clinic: Clinic,
  input: Partial<CreateSplitPaymentRepoInput> & {
    lines: CreatePaymentRepoInput[];
  },
) {
  return tenantContext.run(clinic.tenantId, clinic.locationId, () =>
    payments.createSplit({ receiptPlanBalance: null, ...input }),
  );
}

/** Corre `fn` como dentalix_app con la clínica fijada (como la API). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

const counterOf = async (tenantId: string): Promise<number> =>
  (await raw.paymentReceiptCounter.findMany({ where: { tenantId } })).reduce(
    (sum, c) => sum + c.lastNumber,
    0,
  );

/**
 * DX-450: la fila del plan retenida FOR NO KEY UPDATE por una transacción
 * propia (como un cobro o un traspaso en curso). Quien escriba abonos al plan
 * tiene que ESPERAR aquí; el test lo comprueba en pg_locks (por PID) antes de
 * soltar, así que no pasa si se quita el candado de producción.
 */
const holdPlanLock = (clinic: Clinic, planId = clinic.planId) =>
  holdLock(
    raw,
    (tx) =>
      tx.$queryRaw`SELECT 1 FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR NO KEY UPDATE`,
  );

describe('DX-390 · cobro dividido con un solo recibo (int)', () => {
  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      raw.$disconnect(),
      appRole.$disconnect(),
      prisma.$disconnect(),
    ]);
  });

  it('todas las líneas y UN recibo con todas ellas, en una transacción', async () => {
    const before = await counterOf(a.tenantId);
    const record = await split(a, {
      lines: [
        line(a, { amount: 150_000, method: 'CASH', paymentMethodId: null }),
        line(a, {
          amount: 50_000,
          reference: 'TR-1',
          referenceNormalized: 'TR1',
        }),
      ],
      receiptPlanBalance: {
        currency: 'USD',
        billable: 500_000,
        paid: 200_000,
        balance: 300_000,
      },
    });

    const rows = await raw.payment.findMany({
      where: { splitId: record.splitId },
      orderBy: { splitLine: 'asc' },
      select: { id: true, splitLine: true, amount: true },
    });
    expect(rows.map((r) => [r.splitLine, r.amount.toNumber()])).toEqual([
      [1, 150_000],
      [2, 50_000],
    ]);
    expect(rows[0].id).toBe(record.splitId);
    const receipts = await raw.paymentReceipt.findMany({
      where: { paymentId: { in: rows.map((r) => r.id) } },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].paymentId).toBe(record.splitId);
    expect(await counterOf(a.tenantId)).toBe(before + 1);
    const snapshot = parseReceiptSnapshot(receipts[0].snapshot);
    expect(
      snapshot.split?.lines.map((l) => [l.line, l.amount, l.reference]),
    ).toEqual([
      [1, 150_000, null],
      [2, 50_000, 'TR-1'],
    ]);
    // Misma moneda que el plan: el equivalente es el importe y suma el total.
    expect(snapshot.split?.total).toEqual({ currency: 'USD', amount: 200_000 });
    expect(snapshot.planBalance?.balance).toBe(300_000);
    expect(
      record.payments.every((p) => p.receiptNumber === record.receiptNumber),
    ).toBe(true);

    // Cada línea se lee con el número del recibo del cobro.
    const second = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.findById(rows[1].id),
    );
    expect(second?.receiptNumber).toBe(record.receiptNumber);
    expect(second?.splitId).toBe(record.splitId);
  });

  it('atomicidad: si la última línea falla en la BD (medio de otra clínica, FK compuesta), no queda ninguna ni se gasta número', async () => {
    const before = await raw.payment.count({ where: { tenantId: a.tenantId } });
    const numbers = await counterOf(a.tenantId);

    await expect(
      split(a, {
        lines: [
          line(a, { amount: 10_000 }),
          line(a, { amount: 20_000, method: 'CASH', paymentMethodId: null }),
          // El gate lo rechazaría antes; aquí la red es la FK compuesta.
          line(a, { amount: 30_000, paymentMethodId: b.methodId }),
        ],
        idempotencyKey: randomUUID(),
        requestFingerprint: 'f'.repeat(64),
      }),
    ).rejects.toThrow();

    expect(await raw.payment.count({ where: { tenantId: a.tenantId } })).toBe(
      before,
    );
    expect(await counterOf(a.tenantId)).toBe(numbers);
    expect(
      await raw.paymentPlanAmount.count({ where: { tenantId: a.tenantId } }),
    ).toBe(
      await raw.paymentPlanAmount.count({
        where: { tenantId: a.tenantId, payment: { deletedAt: null } },
      }),
    );
  });

  it('dos reintentos simultáneos del mismo cobro dejan un solo cobro y devuelven el mismo', async () => {
    const key = randomUUID();
    const input = {
      lines: [line(a, { amount: 1_000 }), line(a, { amount: 2_000 })],
      idempotencyKey: key,
      requestFingerprint: 'a'.repeat(64),
    };
    // DX-450: el plan retenido; los dos reintentos llegan y esperan EN el plan
    // (no en serie), y solo entonces se suelta.
    const lock = await holdPlanLock(a);
    let attempts: Promise<Outcome<SplitPaymentRecord>>[] = [];
    try {
      attempts = [settle(split(a, input)), settle(split(a, input))];
      await waitForLockWaiters(raw, [lock.pid], 2);
    } finally {
      lock.release();
      await lock.done;
    }
    const outcomes = await Promise.all(attempts);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const [one, two] = outcomes.map(
      (o) => (o as { value: SplitPaymentRecord }).value,
    );
    expect(one.splitId).toBe(two.splitId);
    expect(await raw.payment.count({ where: { splitId: one.splitId } })).toBe(
      2,
    );
    // Solo la línea 1 lleva la clave.
    expect(await raw.payment.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('la BD exige la forma del cobro: la línea 1 es la de splitId, una línea por número y de la misma clínica', async () => {
    const head = (
      await split(a, {
        lines: [line(a, { amount: 1 }), line(a, { amount: 2 })],
      })
    ).splitId;
    const base = {
      locationId: a.locationId,
      treatmentPlanId: a.planId,
      patientId: a.patientId,
      amount: 1,
      currency: 'USD',
      paidAt: new Date(),
    };
    // Una línea 1 que no es la cabeza.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, tenantId: a.tenantId, splitId: head, splitLine: 1 },
        }),
      ),
    ).rejects.toThrow(/payments_split_check/);
    // Un número de línea repetido.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, tenantId: a.tenantId, splitId: head, splitLine: 2 },
        }),
      ),
    ).rejects.toThrow();
    // splitId sin número, o fuera de 1–5.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, tenantId: a.tenantId, splitId: head },
        }),
      ),
    ).rejects.toThrow(/payments_split_check/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, tenantId: a.tenantId, splitId: head, splitLine: 6 },
        }),
      ),
    ).rejects.toThrow(/payments_split_check/);
    // Una línea de la clínica B que apunta al cobro de A: la FK compuesta.
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.payment.create({
          data: {
            locationId: b.locationId,
            treatmentPlanId: b.planId,
            patientId: b.patientId,
            amount: 1,
            currency: 'USD',
            paidAt: new Date(),
            tenantId: b.tenantId,
            splitId: head,
            splitLine: 3,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('RLS: otra clínica no ve el cobro ni sus líneas', async () => {
    const record = await split(a, {
      lines: [line(a, { amount: 3 }), line(a, { amount: 4 })],
    });
    const seen = await tenantContext.run(b.tenantId, b.locationId, () =>
      payments.findSplit(record.splitId),
    );
    expect(seen).toBeNull();
    const own = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.findSplit(record.splitId),
    );
    expect(own?.payments).toHaveLength(2);
  });

  it('anular una línea anula todas y el recibo, en la misma transacción', async () => {
    const record = await split(a, {
      lines: [
        line(a, { amount: 5 }),
        line(a, { amount: 6 }),
        line(a, { amount: 7 }),
      ],
    });
    const voided = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.softDelete(record.payments[2].id, {
        voidedById: a.userId,
        voidedByRole: 'ADMIN',
        voidedAt: new Date(),
        reason: 'Duplicado',
        request: null,
      }),
    );
    expect(voided).toBe(true);
    const rows = await raw.payment.findMany({
      where: { splitId: record.splitId },
      select: { deletedAt: true },
    });
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    const receipt = await raw.paymentReceipt.findUniqueOrThrow({
      where: { paymentId: record.splitId },
    });
    expect(receipt.voidReason).toBe('Duplicado');
  });

  // Revisión DX-390: lo pendiente se lee fuera de la transacción; sin
  // `confirmCreditBalance`, la transacción bloquea el plan y comprueba que
  // ningún abono llegó al plan entre la lectura y el alta (dos cobros a la vez
  // no dejan saldo a favor sin confirmarlo).
  it('saldo a favor sin confirmar: si otro abono llegó al plan tras leer lo pendiente, 409 y no queda ninguna línea', async () => {
    const seen = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.countPlanMovements(a.planId),
    );
    // Otro cobro entra entre la lectura de lo pendiente y la transacción.
    await split(a, { lines: [line(a, { amount: 8 }), line(a, { amount: 9 })] });
    const counter = await counterOf(a.tenantId);
    const rowsBefore = await raw.payment.count({
      where: { tenantId: a.tenantId },
    });

    await expect(
      split(a, {
        lines: [line(a, { amount: 10 }), line(a, { amount: 11 })],
        balanceGuard: { planMovementsSeen: seen },
      }),
    ).rejects.toMatchObject({
      response: { code: 'SPLIT_PAYMENT_BALANCE_CHANGED' },
    });
    expect(await raw.payment.count({ where: { tenantId: a.tenantId } })).toBe(
      rowsBefore,
    );
    expect(await counterOf(a.tenantId)).toBe(counter);

    // Con la cuenta al día, el cobro entra.
    const fresh = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.countPlanMovements(a.planId),
    );
    const record = await split(a, {
      lines: [line(a, { amount: 10 }), line(a, { amount: 11 })],
      balanceGuard: { planMovementsSeen: fresh },
    });
    expect(record.payments).toHaveLength(2);
  });

  it('dos cobros simultáneos sin confirmar con la misma lectura de lo pendiente: entra uno y el otro es 409', async () => {
    const seen = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.countPlanMovements(a.planId),
    );
    // DX-450: con el plan retenido, los dos cobros llegan con la MISMA
    // lectura y esperan EN el plan; al soltar, el primero entra y el segundo
    // ve el conteo ya cambiado. Sin ese candado ninguno espera (y, si
    // esperaran en serie, el resultado sería el mismo: por eso se comprueba
    // la espera, no solo el desenlace).
    const lock = await holdPlanLock(a);
    let attempts: Promise<Outcome<SplitPaymentRecord>>[] = [];
    try {
      attempts = [
        settle(
          split(a, {
            lines: [line(a, { amount: 12 }), line(a, { amount: 13 })],
            balanceGuard: { planMovementsSeen: seen },
          }),
        ),
        settle(
          split(a, {
            lines: [line(a, { amount: 14 }), line(a, { amount: 15 })],
            balanceGuard: { planMovementsSeen: seen },
          }),
        ),
      ];
      await waitForLockWaiters(raw, [lock.pid], 2);
    } finally {
      lock.release();
      await lock.done;
    }
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { response: { code: 'SPLIT_PAYMENT_BALANCE_CHANGED' } },
    });
    // Y solo entró UN cobro de dos líneas desde la lectura.
    const winner = results.find((r) => r.status === 'fulfilled') as {
      value: SplitPaymentRecord;
    };
    expect(
      await tenantContext.run(a.tenantId, a.locationId, () =>
        payments.countPlanMovements(a.planId),
      ),
    ).toBe(seen + 2);
    expect(winner.value.payments).toHaveLength(2);
  });
  // DX-463 (BE-058): un traspaso de saldo a favor al plan (DX-253) también
  // cambia lo pendiente, aunque no sea un abono: la guarda lo cuenta.
  describe('DX-463 · traspaso de saldo a favor a la vez que un cobro dividido', () => {
    /**
     * Otra conexión con el plan bloqueado (como un traspaso en curso): el
     * cobro llega, espera el bloqueo (visto en pg_locks, por el PID del
     * holder), y solo entonces el traspaso confirma.
     */
    const transferWhileSplitWaits = async (
      clinic: Clinic,
      sourcePlanId: string,
      startSplit: () => Promise<unknown>,
    ) => {
      const lock = await holdLock(
        raw,
        (tx) =>
          tx.$queryRaw`SELECT 1 FROM "treatment_plans" WHERE "id" = ${clinic.planId}::uuid FOR NO KEY UPDATE`,
        async (tx) => {
          const transfer = await tx.patientCreditTransfer.create({
            data: {
              tenantId: clinic.tenantId,
              locationId: clinic.locationId,
              patientId: clinic.patientId,
              sourcePlanId,
              targetPlanId: clinic.planId,
              currency: 'USD',
              amount: new Prisma.Decimal('25.00'),
              reason: 'Traspaso de prueba DX-463',
              createdById: clinic.userId,
            },
          });
          await tx.patientCreditEntry.createMany({
            data: [
              {
                tenantId: clinic.tenantId,
                patientId: clinic.patientId,
                treatmentPlanId: sourcePlanId,
                currency: 'USD',
                amount: new Prisma.Decimal('-25.00'),
                kind: 'TRANSFER_OUT',
                transferId: transfer.id,
              },
              {
                tenantId: clinic.tenantId,
                patientId: clinic.patientId,
                treatmentPlanId: clinic.planId,
                currency: 'USD',
                amount: new Prisma.Decimal('25.00'),
                kind: 'TRANSFER_IN',
                transferId: transfer.id,
              },
            ],
          });
        },
      );
      let attempt: Promise<Outcome<unknown>> | undefined;
      try {
        attempt = settle(startSplit());
        await waitForLockWaiters(raw, [lock.pid], 1);
      } finally {
        lock.release();
        await lock.done;
      }
      return attempt;
    };

    it('el traspaso entra entre la lectura de lo pendiente y el cobro: 409 y no queda ninguna línea', async () => {
      const source = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          currency: 'USD',
          status: TreatmentPlanStatus.ACCEPTED,
        },
      });
      const seen = await tenantContext.run(a.tenantId, a.locationId, () =>
        payments.countPlanMovements(a.planId),
      );
      const rowsBefore = await raw.payment.count({
        where: { tenantId: a.tenantId },
      });
      const outcome = await transferWhileSplitWaits(a, source.id, () =>
        split(a, {
          lines: [line(a, { amount: 30 }), line(a, { amount: 31 })],
          balanceGuard: { planMovementsSeen: seen },
        }),
      );
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { response: { code: 'SPLIT_PAYMENT_BALANCE_CHANGED' } },
      });
      expect(await raw.payment.count({ where: { tenantId: a.tenantId } })).toBe(
        rowsBefore,
      );
    });
  });

  // DX-463 (L4): lo pendiente se recalcula bajo el bloqueo del plan; un
  // descuento que no añade filas ya no deja pasar un excedente sin confirmar.
  it('DX-463: el total del plan baja entre la lectura y el cobro (descuento sin filas nuevas): la guarda en la transacción ve lo pendiente de ahora y da 409', async () => {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        currency: 'USD',
        status: TreatmentPlanStatus.ACCEPTED,
      },
    });
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'dx463',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        catalogItemId: catalog.id,
        toothNumber: '11',
        price: 100,
        discount: 0,
        status: 'ACCEPTED',
      },
    });
    const seen = await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.countPlanMovements(plan.id),
    );
    // Otra sesión descuenta el ítem: lo pendiente baja a 40, sin abonos ni
    // asientos nuevos (el conteo no se mueve).
    await raw.treatmentPlanItem.update({
      where: { id: item.id },
      data: { discount: 60 },
    });
    const seenGuard: { billable: number }[] = [];
    const rowsBefore = await raw.payment.count({
      where: { tenantId: a.tenantId, treatmentPlanId: plan.id },
    });
    await expect(
      split(a, {
        lines: [
          line(a, { treatmentPlanId: plan.id, amount: 50 }),
          line(a, { treatmentPlanId: plan.id, amount: 50 }),
        ],
        balanceGuard: { planMovementsSeen: seen },
        excessGuardInTx: ({ snapshot }) => {
          const billable = snapshot.items.reduce(
            (sum, i) => sum + i.price - i.discount,
            0,
          );
          seenGuard.push({ billable });
          if (100 > billable) {
            throw new ConflictException({
              code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE',
            });
          }
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({
      response: { code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE' },
    });
    expect(seenGuard).toEqual([{ billable: 40 }]);
    expect(
      await raw.payment.count({
        where: { tenantId: a.tenantId, treatmentPlanId: plan.id },
      }),
    ).toBe(rowsBefore);
  });

  // DX-463 ronda 2: un abono «sin tasa» (VES en un plan en USD, sin base) no
  // suma en `paid` y solo puede reducir lo pendiente: la guarda compara con lo
  // conocido, con la cuenta REAL del saldo sobre la foto bajo el bloqueo.
  it('DX-463: con un abono VES sin tasa en un plan en USD, el cobro que cabe en lo conocido entra y el que lo supera da 409 (nunca 503)', async () => {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        currency: 'USD',
        status: TreatmentPlanStatus.ACCEPTED,
      },
    });
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'dx463b',
        kind: 'PROCEDURE',
        labelEs: 'Corona',
        color: '#123456',
      },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        catalogItemId: catalog.id,
        toothNumber: '12',
        price: 100,
        discount: 0,
        status: 'ACCEPTED',
      },
    });
    // El abono en VES queda sin base (sin tasa de su día).
    await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.create(
        line(a, { treatmentPlanId: plan.id, amount: 400, currency: 'VES' }),
      ),
    );
    const balance = new GetPlanBalanceUseCase(
      payments,
      new GetTreatmentPlanUseCase(
        new PrismaTreatmentPlanRepository(prisma, tenantContext),
      ),
      {} as unknown as ConvertAmountUseCase,
      new PrismaPlanAllocationRepository(prisma, tenantContext),
    );
    const guardFor =
      (total: number, seenNow: { withoutRate: number }[]) =>
      async (data: {
        planId: string;
        snapshot: PlanBalanceSnapshot;
        creditMovements: number;
      }) => {
        const now = await balance.fromSnapshot(
          data.planId,
          data.snapshot,
          data.creditMovements,
          { offline: true },
        );
        seenNow.push({ withoutRate: now.paymentsWithoutRate.length });
        if (total > now.balance) {
          throw new ConflictException({
            code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE',
          });
        }
      };
    const attempt = async (amounts: [number, number]) => {
      const seenNow: { withoutRate: number }[] = [];
      const seen = await tenantContext.run(a.tenantId, a.locationId, () =>
        payments.countPlanMovements(plan.id),
      );
      const outcome = await split(a, {
        lines: amounts.map((amount) =>
          line(a, { treatmentPlanId: plan.id, amount }),
        ),
        balanceGuard: { planMovementsSeen: seen },
        excessGuardInTx: guardFor(amounts[0] + amounts[1], seenNow),
      }).then(
        () => 'ok' as const,
        (e: unknown) => e,
      );
      expect(seenNow).toEqual([{ withoutRate: 1 }]);
      return outcome;
    };
    // Conocido: pendiente 100. 120 lo supera -> 409; 100 cabe -> entra.
    expect(await attempt([70, 50])).toMatchObject({
      response: { code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE' },
    });
    expect(await attempt([60, 40])).toBe('ok');
  });
});
