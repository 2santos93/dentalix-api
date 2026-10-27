import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanQuoteRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import type { NewPlanAcceptance } from '../src/modules/treatment-plans/domain/ports/plan-quote-repository.port';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-012 (revisión): orden de bloqueos plan → ítem. La aceptación bloquea el
// plan (FOR UPDATE) y luego los ítems; editar o retirar un ítem tiene que
// bloquear primero el plan y luego el ítem. Con el orden contrario (ítem y
// luego, en el trigger, el plan) dos transacciones se esperaban en cruz:
// deadlock (40P01). Se prueba con los repositorios reales sobre Postgres.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const quotes = new PrismaPlanQuoteRepository(prisma, tenantContext);

const HASH = 'a'.repeat(64);
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Seeded {
  tenantId: string;
  userId: string;
  patientId: string;
  catalogItemId: string;
}

let s: Seeded;

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: 'lock-order', subdomain: 'tpl-lock-order-int' },
  });
  const user = await raw.user.create({
    data: {
      email: 'tpl-lock-order@example.com',
      passwordHash: 'x',
      fullName: 'Dra Orden',
    },
  });
  await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Orden' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'lock-order',
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
  };
}

async function planWithItem(): Promise<{ planId: string; itemId: string }> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'USD' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '11',
      catalogItemId: s.catalogItemId,
      price: 100,
    },
  });
  return { planId: plan.id, itemId: item.id };
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, undefined, fn);
}

function acceptanceRow(locationId: string): NewPlanAcceptance {
  return {
    locationId,
    signerName: 'Ana Orden',
    signature: PNG,
    content: { version: 1 },
    contentHash: HASH,
    acceptanceHash: HASH,
    acceptedAt: new Date(),
    acceptedById: s.userId,
    ipAddress: null,
    userAgent: null,
  };
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

/** 'ok' o el mensaje del error. */
type Settled = string;

function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof Error ? error.message : 'error'),
  );
}

/**
 * Otra transacción tiene el ÍTEM bloqueado; detrás esperan la edición del
 * ítem y la aceptación del plan. Cuando la primera suelta el ítem, las dos
 * tienen que terminar sin deadlock.
 */
async function raceWithItemHeld(
  run: (planId: string, itemId: string) => Promise<unknown>,
): Promise<{ edit: Settled; accept: Settled }> {
  const { planId, itemId } = await planWithItem();
  const location = await raw.location.findFirstOrThrow({
    where: { tenantId: s.tenantId },
  });

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.runWithTenant(s.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "treatment_plan_items" WHERE "id" = ${itemId}::uuid FOR UPDATE`;
    locked();
    await released;
  });
  await isLocked;

  const edit = settle(inTenant(() => run(planId, itemId)));
  await waitForLockWaiters(1);
  const accept = settle(
    inTenant(() =>
      quotes.accept(s.patientId, planId, () => acceptanceRow(location.id)),
    ),
  );
  await waitForLockWaiters(2);
  release();
  await holder;
  return { edit: await edit, accept: await accept };
}

describe('planes de tratamiento: orden de bloqueos plan → ítem (DX-012, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    s = await seed();
  });

  afterAll(async () => {
    const where = { tenantId: s.tenantId };
    await raw.treatmentPlanAcceptance.deleteMany({ where });
    await raw.toothRecord.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.delete({ where: { id: s.tenantId } });
    await raw.user.delete({ where: { id: s.userId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('editar un ítem mientras se acepta el plan: sin deadlock, primero la edición', async () => {
    const result = await raceWithItemHeld((_planId, itemId) =>
      plans.updateItem(itemId, () => ({
        patch: { status: 'ACCEPTED', notes: 'antes de firmar' },
      })),
    );
    expect(result).toEqual({ edit: 'ok', accept: 'ok' });
  });

  it('retirar un ítem mientras se acepta el plan: sin deadlock', async () => {
    const result = await raceWithItemHeld((_planId, itemId) =>
      plans.softDeleteItem(itemId),
    );
    expect(result).toEqual({ edit: 'ok', accept: 'ok' });
  });
});
