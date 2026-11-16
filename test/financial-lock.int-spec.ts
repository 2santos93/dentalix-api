import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { GetPaymentsTotalsUseCase } from '../src/modules/payments/application/use-cases/get-payments-totals.use-case';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { sqlStateOf } from '../src/shared/prisma/prisma-exception.filter';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-091, capa de BD: el trigger payments_financial_lock_guard (la red de
// cualquier camino que olvide la regla) mide el día del abono en la zona de
// su sede, abre la excepción solo para el abono nombrado en el GUC local, y
// la caja del mes cerrado (DX-002) no cambia al intentar escribir en él.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// La app real (dentalix_app, sin superusuario y con RLS).
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPaymentRepository(prisma, tenantContext);
const identityExecute = (input: {
  amount: number;
  from: string;
  to: string;
  date: string;
}) => Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
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
const totals = new GetPaymentsTotalsUseCase(repo, identityConvert);

const SUBDOMAINS = ['dx091-int-a', 'dx091-int-b'];

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const where = { tenantId: { in: ids } };
  await owner.financialLockOverride.deleteMany({ where });
  await owner.paymentAllocation.deleteMany({ where });
  await owner.paymentAllocationMovement.deleteMany({ where });
  await owner.paymentPlanAmount.deleteMany({ where });
  await owner.paymentReceipt.deleteMany({ where });
  await owner.payment.deleteMany({ where });
  await owner.treatmentPlan.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-091 · cierre contable en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let caracas: string;
  let caracasB: string;
  let patientA: string;
  let planA: string;
  let patientB: string;
  let planB: string;
  let closedPayment: string;

  /** Como la app: rol dentalix_app, GUC de la clínica y lo que haga `fn`. */
  const asApp = <T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });

  const insert = (
    tx: Prisma.TransactionClient,
    id: string,
    paidAt: string,
    tenantId = tenantA,
  ) =>
    tx.$executeRaw`
      INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "updatedAt")
      VALUES (${id}::uuid, ${tenantId}::uuid,
              ${tenantId === tenantA ? caracas : caracasB}::uuid,
              ${tenantId === tenantA ? planA : planB}::uuid,
              ${tenantId === tenantA ? patientA : patientB}::uuid,
              10, 'USD', ${new Date(paidAt)}, now())`;

  const stateOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (error) {
      return sqlStateOf(error as Prisma.PrismaClientKnownRequestError);
    }
  };

  const septemberTotal = () =>
    tenantContext.run(tenantA, caracas, () =>
      totals.execute({ from: '2026-09-01', to: '2026-09-30', currency: 'USD' }),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
    const sede = async (tenantId: string, name: string) =>
      (
        await owner.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId,
            name,
            country: 'VE',
            timeZone: 'America/Caracas',
          }),
        })
      ).id;
    caracas = await sede(tenantA, 'Caracas');
    caracasB = await sede(tenantB, 'Caracas B');
    patientA = (
      await owner.patient.create({
        data: { tenantId: tenantA, firstName: 'Ana', lastName: 'Cierre' },
      })
    ).id;
    planA = (
      await owner.treatmentPlan.create({
        data: { tenantId: tenantA, patientId: patientA, currency: 'USD' },
      })
    ).id;
    patientB = (
      await owner.patient.create({
        data: { tenantId: tenantB, firstName: 'Beto', lastName: 'Cierre' },
      })
    ).id;
    planB = (
      await owner.treatmentPlan.create({
        data: { tenantId: tenantB, patientId: patientB, currency: 'USD' },
      })
    ).id;
    // Antes del cierre: un abono del 20/09 (mediodía de Caracas).
    closedPayment = (
      await owner.payment.create({
        data: {
          tenantId: tenantA,
          locationId: caracas,
          treatmentPlanId: planA,
          patientId: patientA,
          amount: 100,
          currency: 'USD',
          paidAt: new Date('2026-09-20T16:00:00.000Z'),
        },
      })
    ).id;
    await owner.tenant.update({
      where: { id: tenantA },
      data: { financialLockDate: new Date('2026-09-30T00:00:00.000Z') },
    });
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
    await appDb.$disconnect();
    await owner.$disconnect();
  });

  it('el día del abono es el de su sede: 30/09 22:00 en Caracas está cerrado; 01/10 00:30, abierto', async () => {
    expect(
      await stateOf(
        asApp(tenantA, (tx) =>
          // 02:00 UTC del 01/10 = 22:00 del 30/09 en Caracas.
          insert(
            tx,
            '00000000-0000-4000-8000-000000000091',
            '2026-10-01T02:00:00.000Z',
          ),
        ),
      ),
    ).toBe('Q0910');
    expect(
      await stateOf(
        asApp(tenantA, (tx) =>
          // 04:30 UTC del 01/10 = 00:30 del 01/10 en Caracas.
          insert(
            tx,
            '00000000-0000-4000-8000-000000000092',
            '2026-10-01T04:30:00.000Z',
          ),
        ),
      ),
    ).toBe('ok');
  });

  it('anular un abono cerrado falla en la BD; cambiar otra columna no', async () => {
    expect(
      await stateOf(
        asApp(
          tenantA,
          (tx) =>
            tx.$executeRaw`UPDATE "payments" SET "deletedAt" = now(), "voidedAt" = now(), "voidReason" = 'prueba' WHERE "id" = ${closedPayment}::uuid`,
        ),
      ),
    ).toBe('Q0910');
    expect(
      await stateOf(
        asApp(
          tenantA,
          (tx) =>
            tx.$executeRaw`UPDATE "payments" SET "externalInvoiceNumber" = 'F-0091' WHERE "id" = ${closedPayment}::uuid`,
        ),
      ),
    ).toBe('ok');
  });

  it('la excepción vale solo para el abono que nombra el GUC local, y solo en su transacción', async () => {
    const allowed = '00000000-0000-4000-8000-000000000093';
    const other = '00000000-0000-4000-8000-000000000094';
    expect(
      await stateOf(
        asApp(tenantA, async (tx) => {
          await tx.$executeRaw`SELECT set_config('dentalix.financial_lock_override', ${allowed}, true)`;
          await insert(tx, other, '2026-09-10T16:00:00.000Z');
        }),
      ),
    ).toBe('Q0910');
    expect(
      await stateOf(
        asApp(tenantA, async (tx) => {
          await tx.$executeRaw`SELECT set_config('dentalix.financial_lock_override', ${allowed}, true)`;
          await insert(tx, allowed, '2026-09-10T16:00:00.000Z');
        }),
      ),
    ).toBe('ok');
    // La transacción siguiente ya no la tiene.
    expect(
      await stateOf(
        asApp(tenantA, (tx) => insert(tx, other, '2026-09-10T16:00:00.000Z')),
      ),
    ).toBe('Q0910');
  });

  it('el cierre de una clínica no toca a otra', async () => {
    expect(
      await stateOf(
        asApp(tenantB, (tx) =>
          insert(
            tx,
            '00000000-0000-4000-8000-000000000095',
            '2026-09-10T16:00:00.000Z',
            tenantB,
          ),
        ),
      ),
    ).toBe('ok');
  });

  it('con días: rige el más tardío de la fecha fija y del cierre por días (en la zona de la sede)', async () => {
    await owner.tenant.update({
      where: { id: tenantA },
      data: { financialLockDays: 7 },
    });
    const [{ through, siteDay }] = await appDb.$queryRaw<
      { through: Date; siteDay: Date }[]
    >`SELECT public.dx_financial_locked_through(${tenantA}::uuid, 'America/Caracas') AS through,
             (timezone('America/Caracas', now()))::date AS "siteDay"`;
    const expected = new Date(siteDay.getTime() - 8 * 24 * 60 * 60 * 1000);
    expect(through.toISOString().slice(0, 10)).toBe(
      expected.toISOString().slice(0, 10),
    );
    await owner.tenant.update({
      where: { id: tenantA },
      data: { financialLockDays: null },
    });
  });

  it('el total de caja de septiembre (DX-002) no cambia al intentar registrar o anular en él', async () => {
    const before = await septemberTotal();
    const actor = {
      userId: '00000000-0000-4000-8000-0000000000aa',
      role: ClinicRole.RECEPTION,
    };
    await expect(
      tenantContext.run(tenantA, caracas, () =>
        repo.create({
          treatmentPlanId: planA,
          patientId: patientA,
          amount: 500,
          currency: 'USD',
          paidAt: { civilDate: '2026-09-25' },
          receiptPlanBalance: null,
          planAmount: null,
          frozenRate: null,
          createdById: actor.userId,
          lockActor: actor,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      tenantContext.run(tenantA, caracas, () =>
        repo.softDelete(closedPayment, {
          voidedById: actor.userId,
          voidedByRole: actor.role,
          voidedAt: new Date(),
          reason: 'Intento de anular un mes cerrado',
          request: null,
        }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PERIOD_LOCKED',
        lockedThrough: '2026-09-30',
      }) as unknown,
    });
    expect(await septemberTotal()).toEqual(before);
  });

  it('el registro de excepciones no admite UPDATE ni DELETE de la app', async () => {
    await owner.tenant.update({
      where: { id: tenantA },
      data: { financialLockAdminExempt: true },
    });
    const admin = {
      userId: '00000000-0000-4000-8000-0000000000ab',
      role: ClinicRole.ADMIN,
      overrideReason: 'Abono olvidado de septiembre',
    };
    const created = await tenantContext.run(tenantA, caracas, () =>
      repo.create({
        treatmentPlanId: planA,
        patientId: patientA,
        amount: 7,
        currency: 'USD',
        paidAt: { civilDate: '2026-09-25' },
        receiptPlanBalance: null,
        planAmount: null,
        frozenRate: null,
        createdById: admin.userId,
        lockActor: admin,
      }),
    );
    const rows = await owner.financialLockOverride.findMany({
      where: { tenantId: tenantA, paymentId: created.id },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        operation: 'PAYMENT_CREATE',
        actorUserId: admin.userId,
        reason: 'Abono olvidado de septiembre',
        locationId: caracas,
      }),
    ]);
    expect(
      await stateOf(
        asApp(
          tenantA,
          (tx) =>
            tx.$executeRaw`UPDATE "financial_lock_overrides" SET "reason" = 'otro' WHERE "tenantId" = ${tenantA}::uuid`,
        ),
      ),
    ).not.toBe('ok');
    expect(
      await stateOf(
        asApp(
          tenantA,
          (tx) =>
            tx.$executeRaw`DELETE FROM "financial_lock_overrides" WHERE "tenantId" = ${tenantA}::uuid`,
        ),
      ),
    ).not.toBe('ok');
    // Otra clínica no ve la fila (RLS).
    const seenByB = await asApp(tenantB, (tx) =>
      tx.financialLockOverride.count(),
    );
    expect(seenByB).toBe(0);
  });
});
