import {
  ClinicRole,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanQuoteRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { UpdateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import { RejectTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/reject-treatment-plan.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import { GetTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/get-treatment-plan.use-case';
import type { GetDiscountPolicyUseCase } from '../src/modules/discounts/application/use-cases/discount-policy.use-cases';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { ReceiptPlanBalanceCalculator } from '../src/modules/payments/application/receipts/receipt-plan-balance';
import { RecordPaymentUseCase } from '../src/modules/payments/application/use-cases/record-payment.use-case';
import { GetPlanBalanceUseCase } from '../src/modules/payments/application/use-cases/get-plan-balance.use-case';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import type { CurrencyWhitelist } from '../src/modules/treatment-plans/domain/ports/currency-whitelist.port';

// DX-109, contra Postgres y bajo RLS (rol dentalix_app vía runWithTenant):
//  1. abono sobre plan no cobrable → 409, con el estado leído en el SELECT
//     FOR SHARE del INSERT;
//  3. PATCH ACCEPTED y aceptación firmada dejan el mismo `billable`;
//  7. Idempotency-Key con huella de la petición;
//  5. trigger de respaldo de ítems en planes cerrados.
// `owner` (DIRECT_URL) solo siembra, cambia estados «por detrás» y limpia.

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const planRepo = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const quoteRepo = new PrismaPlanQuoteRepository(prisma, tenantContext);
const paymentRepo = new PrismaPaymentRepository(prisma, tenantContext);
const whitelist: CurrencyWhitelist = { has: () => Promise.resolve(true) };
const NOW = new Date('2026-10-16T15:00:00.000Z');
const updatePlan = new UpdateTreatmentPlanUseCase(
  planRepo,
  whitelist,
  () => NOW,
);
const rejectPlan = new RejectTreatmentPlanUseCase(planRepo, () => NOW);
const noCatalog = {
  findById: () => Promise.resolve(null),
} as unknown as DentalCatalogRepository;
// Sin descuentos en esta suite: la política no se consulta (DX-204).
const noDiscountPolicy = {
  execute: () => Promise.reject(new Error('no se consulta sin descuento')),
} as unknown as GetDiscountPolicyUseCase;
const updateItem = new UpdateTreatmentPlanItemUseCase(
  planRepo,
  noCatalog,
  noDiscountPolicy,
  () => NOW,
);
const getPlan = new GetTreatmentPlanUseCase(planRepo);
const getQuote = new GetPlanQuoteUseCase(quoteRepo, () => NOW);
const acceptSigned = new AcceptTreatmentPlanUseCase(quoteRepo, () => NOW);
const identityConvert = {
  execute: (input: { amount: number }) =>
    Promise.resolve({ ...input, result: input.amount, rateUsed: 1 }),
} as unknown as ConvertAmountUseCase;
const balance = new GetPlanBalanceUseCase(
  paymentRepo,
  getPlan,
  identityConvert,
);
const recordPayment = new RecordPaymentUseCase(
  paymentRepo,
  getPlan,
  whitelist,
  new ReceiptPlanBalanceCalculator(balance, identityConvert),
);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SUBDOMAIN = 'dx109-int';
const DENTIST = { role: ClinicRole.DENTIST };

describe('DX-109 · reglas de cobro contra Postgres (int)', () => {
  let tenantId: string;
  let userId: string;
  let patientId: string;
  let catalogItemId: string;
  let locationId: string;

  const inTenant = <T>(fn: () => Promise<T>) =>
    tenantContext.run(tenantId, undefined, fn);

  async function purge(): Promise<void> {
    const tenants = await owner.tenant.findMany({
      where: { subdomain: SUBDOMAIN },
      select: { id: true },
    });
    const where = { tenantId: { in: tenants.map((t) => t.id) } };
    await owner.payment.deleteMany({ where });
    await owner.toothRecord.deleteMany({ where });
    await owner.installment.deleteMany({ where });
    await owner.paymentPlan.deleteMany({ where });
    await owner.treatmentPlanAcceptance.deleteMany({ where });
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

  /** Plan con dos ítems PROPOSED (100 − 10 y 50): facturable aceptado 140. */
  async function seedPlan(
    status: TreatmentPlanStatus = TreatmentPlanStatus.DRAFT,
  ): Promise<string> {
    const plan = await owner.treatmentPlan.create({
      data: { tenantId, patientId, currency: 'USD', createdById: userId },
    });
    await owner.treatmentPlanItem.createMany({
      data: [
        { price: 100, discount: 10, toothNumber: '11' },
        { price: 50, discount: 0, toothNumber: '21' },
      ].map((item) => ({ ...item, tenantId, planId: plan.id, catalogItemId })),
    });
    if (status !== TreatmentPlanStatus.DRAFT) {
      await owner.treatmentPlan.update({
        where: { id: plan.id },
        data:
          status === TreatmentPlanStatus.REJECTED
            ? {
                status,
                rejectedAt: NOW,
                rejectionReason: 'OTHER_OPTION_ACCEPTED',
              }
            : status === TreatmentPlanStatus.PRESENTED
              ? { status, presentedAt: NOW, presentedLocationId: locationId }
              : { status },
      });
    }
    return plan.id;
  }

  const body = { amount: 40, currency: 'USD', paidAt: '2026-10-16' };

  /** Plan de cuotas ACTIVO sembrado por detrás (owner). */
  async function seedPaymentPlan(treatmentPlanId: string): Promise<string> {
    const pp = await owner.paymentPlan.create({
      data: {
        tenantId,
        treatmentPlanId,
        patientId,
        currency: 'USD',
        totalToFinance: 140,
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: NOW,
      },
    });
    return pp.id;
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
          fullName: 'Dra DX-109',
        },
      })
    ).id;
    locationId = (
      await owner.location.create({ data: { tenantId, name: 'Sede' } })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Cobro' },
      })
    ).id;
    catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'dx109',
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

  describe('criterio 1: abonos solo sobre planes cobrables', () => {
    it.each([TreatmentPlanStatus.REJECTED, TreatmentPlanStatus.CANCELLED])(
      'plan %s → 409 en español y ningún abono',
      async (status) => {
        const planId = await seedPlan(status);
        await expect(
          inTenant(() => recordPayment.execute(planId, body)),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringMatching(/no admite abonos/) as string,
        });
        expect(
          await owner.payment.count({ where: { treatmentPlanId: planId } }),
        ).toBe(0);
      },
    );

    it('COMPLETED sigue admitiendo abonos', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.COMPLETED);
      const payment = await inTenant(() => recordPayment.execute(planId, body));
      expect(payment.treatmentPlanId).toBe(planId);
    });

    it('el repositorio relee el estado en el INSERT: un plan cancelado tras la comprobación del caso de uso → 409', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      await owner.treatmentPlan.update({
        where: { id: planId },
        data: { status: TreatmentPlanStatus.CANCELLED },
      });
      await expect(
        inTenant(() =>
          paymentRepo.create({
            treatmentPlanId: planId,
            patientId,
            amount: 10,
            currency: 'USD',
            paidAt: NOW,
            receiptPlanBalance: null,
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('el abono bloquea el plan: una cancelación concurrente espera a su COMMIT', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      // Transacción que toma el plan FOR UPDATE como el PATCH de cancelar y
      // lo cancela; el INSERT del abono, que pide FOR SHARE, espera y luego
      // ve CANCELLED → 409.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const locker = owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
          await tx.treatmentPlan.update({
            where: { id: planId },
            data: { status: TreatmentPlanStatus.CANCELLED },
          });
          await held;
        },
        { timeout: 20_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const attempt = inTenant(() => recordPayment.execute(planId, body));
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await locker;
      await expect(attempt).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('criterio 3: PATCH ACCEPTED y aceptación firmada, mismo resultado', () => {
    it('ambas rutas dejan los ítems ACCEPTED y el mismo billable', async () => {
      const patched = await seedPlan();
      const signed = await seedPlan();

      await inTenant(() =>
        updatePlan.execute(
          patched,
          { status: TreatmentPlanStatus.ACCEPTED },
          DENTIST,
        ),
      );
      const quote = await inTenant(() => getQuote.execute(patientId, signed));
      await inTenant(() =>
        acceptSigned.execute(
          patientId,
          signed,
          {
            signerName: 'Ana Cobro',
            signature: `data:image/png;base64,${PNG}`,
            contentHash: quote.contentHash,
          },
          { acceptedById: userId, ipAddress: null, userAgent: null },
        ),
      );

      const [viaPatch, viaSignature] = await Promise.all(
        [patched, signed].map((id) => inTenant(() => balance.execute(id))),
      );
      expect(viaPatch.billable).toBe(140);
      expect(viaSignature.billable).toBe(viaPatch.billable);
      for (const id of [patched, signed]) {
        const plan = await owner.treatmentPlan.findUniqueOrThrow({
          where: { id },
          include: { items: true },
        });
        expect(plan.status).toBe(TreatmentPlanStatus.ACCEPTED);
        expect(plan.items.map((i) => i.status)).toEqual([
          TreatmentPlanItemStatus.ACCEPTED,
          TreatmentPlanItemStatus.ACCEPTED,
        ]);
      }
    });

    it('PATCH ACCEPTED rechaza las hermanas abiertas en la misma transacción', async () => {
      const a = await seedPlan();
      const b = await seedPlan();
      const groupId = a;
      await owner.treatmentPlan.updateMany({
        where: { id: { in: [a, b] } },
        data: { optionGroupId: groupId },
      });
      await inTenant(() =>
        updatePlan.execute(
          a,
          { status: TreatmentPlanStatus.ACCEPTED },
          DENTIST,
        ),
      );
      const sibling = await owner.treatmentPlan.findUniqueOrThrow({
        where: { id: b },
      });
      expect(sibling).toMatchObject({
        status: TreatmentPlanStatus.REJECTED,
        rejectionReason: 'OTHER_OPTION_ACCEPTED',
      });
    });
  });

  describe('criterio 2: cancelar el plan cancela su plan de cuotas', () => {
    it('el plan de cuotas ACTIVO queda CANCELLED con autor y motivo', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      const pp = await owner.paymentPlan.create({
        data: {
          tenantId,
          treatmentPlanId: planId,
          patientId,
          currency: 'USD',
          totalToFinance: 140,
          installmentsCount: 2,
          periodicity: 'MONTHLY',
          startDate: NOW,
        },
      });
      await inTenant(() =>
        updatePlan.execute(
          planId,
          { status: TreatmentPlanStatus.CANCELLED },
          { role: ClinicRole.DENTIST, userId },
        ),
      );
      expect(
        await owner.paymentPlan.findUniqueOrThrow({ where: { id: pp.id } }),
      ).toMatchObject({
        status: 'CANCELLED',
        cancelledAt: NOW,
        cancelledById: userId,
        cancelReason: 'Se canceló el plan de tratamiento.',
      });
    });
  });

  describe('criterio 7: huella de la Idempotency-Key', () => {
    it('idéntica → el original; otro cuerpo u otro plan → 422 sin nuevo abono', async () => {
      const planA = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      const planB = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      const key = '9b3c2d10-1f0e-4a8b-9c7d-0e1f2a3b4c5d';

      const first = await inTenant(() =>
        recordPayment.execute(planA, body, userId, key),
      );
      const stored = await owner.payment.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(stored.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/);

      const replay = await inTenant(() =>
        recordPayment.execute(planA, { ...body }, userId, key),
      );
      expect(replay.id).toBe(first.id);

      await expect(
        inTenant(() =>
          recordPayment.execute(planA, { ...body, amount: 41 }, userId, key),
        ),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        inTenant(() => recordPayment.execute(planB, body, userId, key)),
      ).rejects.toMatchObject({ status: 422 });
      expect(
        await owner.payment.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });

    it('carrera: dos peticiones simultáneas con la misma clave y distinto cuerpo → una se guarda y la otra es 422', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      const key = '7c1d2e30-2a4b-4c5d-8e9f-1a2b3c4d5e6f';
      const results = await Promise.allSettled([
        inTenant(() => recordPayment.execute(planId, body, userId, key)),
        inTenant(() =>
          recordPayment.execute(planId, { ...body, amount: 99 }, userId, key),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 422 });
      expect(
        await owner.payment.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });
  });

  describe('criterio 5: trigger de respaldo de ítems en planes cerrados', () => {
    it.each([
      TreatmentPlanStatus.CANCELLED,
      TreatmentPlanStatus.REJECTED,
      TreatmentPlanStatus.COMPLETED,
    ])(
      'con el rol de la app, un plan %s no admite INSERT ni UPDATE de ítems',
      async (status) => {
        const planId = await seedPlan(status);
        const item = await owner.treatmentPlanItem.findFirstOrThrow({
          where: { planId },
        });
        await expect(
          inTenant(() =>
            prisma.runWithTenant((tx) =>
              tx.treatmentPlanItem.create({
                data: {
                  tenantId,
                  planId,
                  catalogItemId,
                  toothNumber: '31',
                  price: 1,
                },
              }),
            ),
          ),
        ).rejects.toThrow(/restrict_violation|23001|cerrado/);
        await expect(
          inTenant(() =>
            prisma.runWithTenant((tx) =>
              tx.treatmentPlanItem.update({
                where: { id: item.id },
                data: { price: 1 },
              }),
            ),
          ),
        ).rejects.toThrow(/restrict_violation|23001|cerrado/);
      },
    );
  });

  describe('revisión DX-109: rechazar también cancela el plan de cuotas', () => {
    it('«Rechazar» deja el plan de cuotas ACTIVO en CANCELLED con autor y motivo, en la misma transacción', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.PRESENTED);
      const ppId = await seedPaymentPlan(planId);
      await inTenant(() =>
        rejectPlan.execute(planId, { reason: 'PRICE' }, userId),
      );
      expect(
        await owner.paymentPlan.findUniqueOrThrow({ where: { id: ppId } }),
      ).toMatchObject({
        status: 'CANCELLED',
        cancelledAt: NOW,
        cancelledById: userId,
        cancelReason: 'Se rechazó el plan de tratamiento.',
      });
    });

    it('aceptar una opción cancela el plan de cuotas de la hermana que rechaza', async () => {
      const a = await seedPlan();
      const b = await seedPlan(TreatmentPlanStatus.PRESENTED);
      await owner.treatmentPlan.updateMany({
        where: { id: { in: [a, b] } },
        data: { optionGroupId: a },
      });
      const ppId = await seedPaymentPlan(b);
      await inTenant(() =>
        updatePlan.execute(
          a,
          { status: TreatmentPlanStatus.ACCEPTED },
          { role: ClinicRole.DENTIST, userId },
        ),
      );
      expect(
        await owner.treatmentPlan.findUniqueOrThrow({ where: { id: b } }),
      ).toMatchObject({ status: TreatmentPlanStatus.REJECTED });
      expect(
        await owner.paymentPlan.findUniqueOrThrow({ where: { id: ppId } }),
      ).toMatchObject({
        status: 'CANCELLED',
        cancelledById: userId,
        cancelReason: 'Se aceptó otra opción del grupo de tratamiento.',
      });
    });
  });

  describe('revisión DX-109: plan completado con un procedimiento pendiente', () => {
    it('con el rol de la app, ACCEPTED → DONE pasa (y llega al odontograma); cualquier otro cambio sigue bloqueado', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      await owner.treatmentPlanItem.updateMany({
        where: { planId },
        data: { status: TreatmentPlanItemStatus.ACCEPTED },
      });
      await owner.treatmentPlan.update({
        where: { id: planId },
        data: { status: TreatmentPlanStatus.COMPLETED },
      });
      const [first, second] = await owner.treatmentPlanItem.findMany({
        where: { planId },
        orderBy: { toothNumber: 'asc' },
      });

      const done = await inTenant(() =>
        updateItem.execute(
          first.id,
          { status: TreatmentPlanItemStatus.DONE },
          { userId: userId, role: ClinicRole.ADMIN },
        ),
      );
      expect(done.status).toBe(TreatmentPlanItemStatus.DONE);
      expect(
        await owner.toothRecord.count({
          where: { sourcePlanItemId: first.id },
        }),
      ).toBe(1);

      // Por detrás de la aplicación: el trigger solo deja pasar el DONE limpio.
      await expect(
        inTenant(() =>
          prisma.runWithTenant((tx) =>
            tx.treatmentPlanItem.update({
              where: { id: second.id },
              data: { status: TreatmentPlanItemStatus.DONE, price: 1 },
            }),
          ),
        ),
      ).rejects.toThrow(/restrict_violation|23001|cerrado/);
      await expect(
        inTenant(() =>
          prisma.runWithTenant((tx) =>
            tx.treatmentPlanItem.update({
              where: { id: first.id },
              data: { status: TreatmentPlanItemStatus.ACCEPTED },
            }),
          ),
        ),
      ).rejects.toThrow(/restrict_violation|23001|cerrado/);
    });

    it.each([TreatmentPlanStatus.CANCELLED, TreatmentPlanStatus.REJECTED])(
      'en un plan %s el trigger bloquea también ACCEPTED → DONE',
      async (status) => {
        const planId = await seedPlan(status);
        const item = await owner.treatmentPlanItem.findFirstOrThrow({
          where: { planId },
        });
        await owner.treatmentPlanItem.update({
          where: { id: item.id },
          data: { status: TreatmentPlanItemStatus.ACCEPTED },
        });
        await expect(
          inTenant(() =>
            prisma.runWithTenant((tx) =>
              tx.treatmentPlanItem.update({
                where: { id: item.id },
                data: { status: TreatmentPlanItemStatus.DONE },
              }),
            ),
          ),
        ).rejects.toThrow(/restrict_violation|23001|cerrado/);
      },
    );
  });

  describe('revisión DX-109: forma canónica de paidAt en la huella', () => {
    it('`2026-10-16` y `2026-10-16T00:00:00Z` son la misma petición; otra hora del día no', async () => {
      const planId = await seedPlan(TreatmentPlanStatus.ACCEPTED);
      const key = '3e4f5a60-7b8c-4d9e-8f0a-1b2c3d4e5f60';
      const first = await inTenant(() =>
        recordPayment.execute(planId, body, userId, key),
      );
      const replay = await inTenant(() =>
        recordPayment.execute(
          planId,
          { ...body, paidAt: '2026-10-16T00:00:00.000Z' },
          userId,
          key,
        ),
      );
      expect(replay.id).toBe(first.id);
      await expect(
        inTenant(() =>
          recordPayment.execute(
            planId,
            { ...body, paidAt: '2026-10-16T15:00:00Z' },
            userId,
            key,
          ),
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(
        await owner.payment.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });
  });
});
