import { ConflictException } from '@nestjs/common';
import { ClinicRole, DiscountReason, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from '../src/modules/treatment-plans/application/use-cases/apply-bulk-discount.use-case';
import { ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE } from '../src/modules/treatment-plans/application/use-cases/item-discount';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { PricingSource } from '../src/modules/treatment-plans/domain/ports/pricing-source.port';
import { catalogPricing } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/catalog-pricing-source';

// BE-036 (SEC-041): el estado del plan se comprueba DENTRO de la transacción
// que escribe el ítem, después de bloquear la fila del plan. Antes se leía
// fuera: una aceptación (sin firma, que no tiene trigger) que confirmaba entre
// esa lectura y la escritura dejaba rebajar el precio o descontar un plan ya
// aceptado. Aquí la aceptación tiene el plan bloqueado (FOR UPDATE, como
// `updatePlan`) cuando llega la edición; al confirmar, la edición tiene que
// ver el plan aceptado y no cambiar nada. Repositorio y casos de uso reales
// sobre Postgres; `raw` (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const policy = testDiscountPolicy();
const now = () => new Date();

let catalogEntity: DentalCatalogItem;
const catalog = {
  findById: () => Promise.resolve(catalogEntity),
  findByIds: () => Promise.resolve([catalogEntity]),
} as unknown as DentalCatalogRepository;
// DX-105: sin convenio ni lista; la sede de la foto es la sembrada (FK).
const pricing: PricingSource = {
  contextFor: (patientId, catalogItemId, currency) =>
    catalogPricing(catalog, { locationId: s.locationId }).contextFor(
      patientId,
      catalogItemId,
      currency,
    ),
};

const add = new AddTreatmentPlanItemUseCase(plans, pricing, policy, now);
const update = new UpdateTreatmentPlanItemUseCase(plans, catalog, policy, now);
const bulk = new ApplyBulkDiscountUseCase(plans, policy, now, catalog);

interface Seeded {
  tenantId: string;
  userId: string;
  patientId: string;
  catalogItemId: string;
  locationId: string;
}
let s: Seeded;

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: 'sec041-race', subdomain: 'sec041-accept-race-int' },
  });
  const user = await raw.user.create({
    data: {
      email: 'sec041-race@example.com',
      passwordHash: 'x',
      fullName: 'Dra Carrera',
    },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede principal' },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Carrera' },
  });
  const item = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'sec041-crown',
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
      defaultPrice: 1000000,
    },
  });
  catalogEntity = { ...item, defaultPrice: 1000000 };
  return {
    tenantId: tenant.id,
    userId: user.id,
    patientId: patient.id,
    catalogItemId: item.id,
    locationId: location.id,
  };
}

const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });

async function draftPlanWithItem(): Promise<{
  planId: string;
  itemId: string;
}> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'COP' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '11',
      catalogItemId: s.catalogItemId,
      catalogPrice: 1000000,
      price: 1000000,
    },
  });
  return { planId: plan.id, itemId: item.id };
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, undefined, fn);
}

/** Espera a que haya `n` sesiones de esta base esperando un bloqueo. */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ waiting }] = await raw.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no llegaron ${n} esperas de bloqueo`);
}

/**
 * Acepta el plan como `updatePlan` (fila del plan FOR UPDATE, estado ACCEPTED
 * y sus ítems PROPOSED → ACCEPTED) y NO confirma hasta que `run` está
 * esperando el bloqueo. Devuelve lo que hizo `run` (ok o el error).
 */
async function whileAccepting(
  planId: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted!: () => void;
  const isAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const acceptance = prisma.runWithTenant(s.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
    await tx.treatmentPlanItem.updateMany({
      where: { planId, status: 'PROPOSED', deletedAt: null },
      data: { status: 'ACCEPTED' },
    });
    await tx.treatmentPlan.update({
      where: { id: planId },
      data: { status: 'ACCEPTED' },
    });
    accepted();
    await released;
  });
  await isAccepted;

  const outcome = inTenant(run).then(
    () => 'ok',
    (error: unknown) => error,
  );
  await waitForLockWaiters(1);
  release();
  await acceptance;
  return outcome;
}

describe('BE-036 · aceptar el plan mientras se edita un ítem (int, SEC-041)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    s = await seed();
  });

  afterAll(async () => {
    const where = { tenantId: s.tenantId };
    await raw.toothRecord.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.delete({ where: { id: s.tenantId } });
    await raw.user.delete({ where: { id: s.userId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('editar: la rebaja de precio que espera a la aceptación no se aplica (409) y el ítem queda como estaba', async () => {
    const { planId, itemId } = await draftPlanWithItem();
    const outcome = await whileAccepting(planId, () =>
      update.execute(
        itemId,
        { price: 900000, discountReason: DiscountReason.LOYALTY },
        ADMIN(),
      ),
    );
    expect(outcome).toBeInstanceOf(ConflictException);
    expect((outcome as ConflictException).message).toBe(
      ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE,
    );
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.price.toNumber()).toBe(1000000);
    expect(item.discountById).toBeNull();
    expect(item.status).toBe('ACCEPTED');
  });

  it('añadir: un ítem rebajado que espera a la aceptación no se añade (409)', async () => {
    const { planId } = await draftPlanWithItem();
    const outcome = await whileAccepting(planId, () =>
      add.execute(
        planId,
        {
          toothNumber: '21',
          catalogItemId: s.catalogItemId,
          price: 950000,
        },
        ADMIN(),
      ),
    );
    expect(outcome).toBeInstanceOf(ConflictException);
    expect(
      await raw.treatmentPlanItem.count({ where: { planId, deletedAt: null } }),
    ).toBe(1);
  });

  it('«Descuento %»: el bloque que espera a la aceptación no se aplica (409)', async () => {
    const { planId, itemId } = await draftPlanWithItem();
    const outcome = await whileAccepting(planId, () =>
      bulk.execute(planId, { itemIds: [itemId], percent: 5 }, ADMIN()),
    );
    expect(outcome).toBeInstanceOf(ConflictException);
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.discount.toNumber()).toBe(0);
  });

  it('en el orden contrario (la edición primero) la edición se aplica y la aceptación espera', async () => {
    const { planId, itemId } = await draftPlanWithItem();
    await inTenant(() =>
      update.execute(
        itemId,
        { price: 950000 },
        { userId: s.userId, role: ClinicRole.DENTIST },
      ),
    );
    await inTenant(() =>
      plans.updatePlan(planId, () => ({
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      })),
    );
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.price.toNumber()).toBe(950000);
    expect(item.discountById).toBe(s.userId);
    // Ya aceptado: la rebaja no cambia más.
    await expect(
      inTenant(() => update.execute(itemId, { price: 900000 }, ADMIN())),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
