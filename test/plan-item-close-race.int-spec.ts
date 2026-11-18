import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/remove-treatment-plan-item.use-case';
import { closedPlanItemsMessage } from '../src/modules/treatment-plans/domain/plan-status-machine';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import { ClinicRole } from '@prisma/client';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { backendPid, waitForLockWaiters } from './support/postgres-concurrency';

// DX-123 (R-5 de la revisión de DX-109): el plan se CIERRA (cancelado o
// completado) mientras alguien edita o quita uno de sus ítems. El estado del
// plan se comprueba DENTRO de la transacción que escribe el ítem, con la fila
// del plan bloqueada: la escritura que esperaba al cierre responde el 409 con
// el mensaje de plan cerrado, no el 409 genérico del trigger
// `treatment_plan_items_locked_when_closed`. Repositorio y casos de uso reales
// sobre Postgres; `raw` (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const now = () => new Date();

let catalogEntity: DentalCatalogItem;
const catalog = {
  findById: () => Promise.resolve(catalogEntity),
  findByIds: () => Promise.resolve([catalogEntity]),
} as unknown as DentalCatalogRepository;

const update = new UpdateTreatmentPlanItemUseCase(
  plans,
  catalog,
  testDiscountPolicy(),
  now,
);
const remove = new RemoveTreatmentPlanItemUseCase(plans);

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
    data: { name: 'dx123-close-race', subdomain: 'dx123-close-race-int' },
  });
  const user = await raw.user.create({
    data: {
      email: 'dx123-close-race@example.com',
      passwordHash: 'x',
      fullName: 'Dra Cierre',
    },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Luis', lastName: 'Cierre' },
  });
  const item = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'dx123-resin',
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
      defaultPrice: 80,
    },
  });
  catalogEntity = {
    ...item,
    defaultPrice: 80,
    suggestedClinicalNoteTemplateId: null,
    patientDescription: [],
  };
  return {
    tenantId: tenant.id,
    userId: user.id,
    patientId: patient.id,
    catalogItemId: item.id,
    locationId: location.id,
  };
}

async function draftPlanWithItem(): Promise<{
  planId: string;
  itemId: string;
}> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'USD' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '16',
      catalogItemId: s.catalogItemId,
      catalogPrice: 80,
      price: 80,
    },
  });
  return { planId: plan.id, itemId: item.id };
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, undefined, fn);
}

/**
 * Cierra el plan como `updatePlan` (fila del plan FOR UPDATE y su estado) y NO
 * confirma hasta que `run` espera el bloqueo. Devuelve lo que hizo `run`.
 */
async function whileClosing(
  planId: string,
  status: TreatmentPlanStatus,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed!: () => void;
  const isClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let closingPid!: number;
  const closing = prisma.runWithTenant(s.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
    closingPid = await backendPid(tx);
    await tx.treatmentPlan.update({ where: { id: planId }, data: { status } });
    closed();
    await released;
  });
  await isClosed;

  const outcome = inTenant(run).then(
    () => 'ok',
    (error: unknown) => error,
  );
  await waitForLockWaiters(raw, [closingPid], 1);
  release();
  await closing;
  return outcome;
}

describe('DX-123 · cerrar el plan mientras se edita o quita un ítem (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    s = await seed();
  });

  afterAll(async () => {
    const where = { tenantId: s.tenantId };
    await raw.postOpCheck.deleteMany({ where });
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

  it.each([TreatmentPlanStatus.CANCELLED, TreatmentPlanStatus.COMPLETED])(
    'editar: el cambio que espera al cierre (%s) responde el 409 de plan cerrado y el ítem no cambia',
    async (status) => {
      const { planId, itemId } = await draftPlanWithItem();
      const outcome = await whileClosing(planId, status, () =>
        update.execute(
          itemId,
          { notes: 'Cambio de superficie' },
          { userId: s.userId, role: ClinicRole.ADMIN },
        ),
      );
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((outcome as ConflictException).message).toBe(
        closedPlanItemsMessage(status),
      );
      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.notes).toBeNull();
    },
  );

  it.each([TreatmentPlanStatus.CANCELLED, TreatmentPlanStatus.COMPLETED])(
    'quitar: el borrado que espera al cierre (%s) responde el 409 de plan cerrado y el ítem sigue vivo',
    async (status) => {
      const { planId, itemId } = await draftPlanWithItem();
      const outcome = await whileClosing(planId, status, () =>
        remove.execute(itemId, undefined, planId),
      );
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((outcome as ConflictException).message).toBe(
        closedPlanItemsMessage(status),
      );
      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.deletedAt).toBeNull();
    },
  );

  it('DX-566: el 409 del plan cerrado llega ANTES de anular el control postoperatorio pendiente: el control sigue PENDING', async () => {
    const { planId, itemId } = await draftPlanWithItem();
    const check = await raw.postOpCheck.create({
      data: {
        tenantId: s.tenantId,
        patientId: s.patientId,
        planItemId: itemId,
        locationId: s.locationId,
        professionalId: s.userId,
        catalogItemId: s.catalogItemId,
        procedureName: 'Resina',
        afterDays: 2,
        dueOn: new Date('2099-01-12T00:00:00.000Z'),
      },
    });
    const outcome = await whileClosing(
      planId,
      TreatmentPlanStatus.CANCELLED,
      () => remove.execute(itemId, undefined, planId),
    );
    expect(outcome).toBeInstanceOf(ConflictException);
    const after = await raw.postOpCheck.findUniqueOrThrow({
      where: { id: check.id },
    });
    expect(after.status).toBe('PENDING');
    expect(after.cancelledReason).toBeNull();
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.deletedAt).toBeNull();
  });

  it('con el plan abierto, quitar el ítem sigue funcionando', async () => {
    const { planId, itemId } = await draftPlanWithItem();
    await inTenant(() => remove.execute(itemId, undefined, planId));
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.deletedAt).not.toBeNull();
  });
});
