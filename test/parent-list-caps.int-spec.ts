import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaInventoryRepository } from '../src/modules/inventory/infrastructure/repositories/prisma-inventory.repository';
import { INVENTORY_MOVEMENTS_LIMIT } from '../src/modules/inventory/domain/ports/inventory-repository.port';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import { CLINICAL_ENTRIES_LIMIT } from '../src/modules/clinical-entries/domain/ports/clinical-entry-repository.port';
import { PrismaToothRecordRepository } from '../src/modules/odontogram/infrastructure/repositories/prisma-tooth-record.repository';
import { TOOTH_TIMELINE_LIMIT } from '../src/modules/odontogram/domain/ports/tooth-record-repository.port';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PATIENT_PLANS_LIMIT } from '../src/modules/treatment-plans/domain/ports/treatment-plan-repository.port';

// DX-043 (DB-018): los listados por padre de solo lectura tienen tope en la BD
// y devuelven los MÁS RECIENTES. `raw` (DIRECT_URL, owner) siembra y limpia;
// las lecturas van por los repositorios reales (rol dentalix_app, RLS).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const BASE = Date.UTC(2026, 0, 1);
const minutes = (n: number) => new Date(BASE + n * 60_000);

describe('Topes de listados por padre (DX-043, int)', () => {
  let tenantId: string;
  let locationId: string;
  let patientId: string;
  let itemId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    const tenant = await raw.tenant.create({
      data: { name: 'dx043-caps', subdomain: 'dx043-caps' },
    });
    tenantId = tenant.id;
    locationId = (
      await raw.location.create({ data: { tenantId, name: 'Sede' } })
    ).id;
    patientId = (
      await raw.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Topes' },
      })
    ).id;
    itemId = (
      await raw.inventoryItem.create({
        data: { tenantId, locationId, name: 'Guantes', unit: 'caja' },
      })
    ).id;
  });

  afterAll(async () => {
    await raw.inventoryMovement.deleteMany({ where: { tenantId } });
    await raw.inventoryItem.deleteMany({ where: { tenantId } });
    await raw.clinicalEntry.deleteMany({ where: { tenantId } });
    await raw.toothRecord.deleteMany({ where: { tenantId } });
    await raw.treatmentPlan.deleteMany({ where: { tenantId } });
    await raw.patient.deleteMany({ where: { tenantId } });
    await raw.locationSchedule.deleteMany({ where: { tenantId } });
    await raw.location.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(tenantId, fn);
  }

  it(`movimientos de un insumo: los ${INVENTORY_MOVEMENTS_LIMIT} más recientes; el stock suma todos`, async () => {
    const n = INVENTORY_MOVEMENTS_LIMIT + 1;
    await raw.inventoryMovement.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        locationId,
        itemId,
        type: 'IN' as const,
        quantity: 1,
        occurredAt: minutes(i),
      })),
    });
    const repo = new PrismaInventoryRepository(prisma, tenantContext);
    const movements = await inTenant(() => repo.listMovements(itemId));
    expect(movements).toHaveLength(INVENTORY_MOVEMENTS_LIMIT);
    expect(movements[0].occurredAt).toEqual(minutes(n - 1));
    expect(movements.at(-1)?.occurredAt).toEqual(minutes(1));
    expect(await inTenant(() => repo.sumSignedQuantity(itemId))).toBe(n);
  });

  it(`evoluciones de un paciente: las ${CLINICAL_ENTRIES_LIMIT} más recientes`, async () => {
    const n = CLINICAL_ENTRIES_LIMIT + 1;
    await raw.clinicalEntry.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        patientId,
        entryDate: minutes(i),
        notes: `Evolución ${i}`,
      })),
    });
    const repo = new PrismaClinicalEntryRepository(prisma, tenantContext);
    const entries = await inTenant(() => repo.listByPatient(patientId));
    expect(entries).toHaveLength(CLINICAL_ENTRIES_LIMIT);
    expect(entries[0].entryDate).toEqual(minutes(n - 1));
    // La más antigua se alcanza acotando el rango.
    const oldest = await inTenant(() =>
      repo.listByPatient(patientId, { to: minutes(0) }),
    );
    expect(oldest.map((e) => e.notes)).toEqual(['Evolución 0']);
  });

  it(`línea de tiempo de un diente: los ${TOOTH_TIMELINE_LIMIT} más recientes; el odontograma ve todos`, async () => {
    const n = TOOTH_TIMELINE_LIMIT + 1;
    await raw.toothRecord.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        patientId,
        toothNumber: '11',
        kind: 'DIAGNOSIS' as const,
        recordedAt: minutes(i),
      })),
    });
    const repo = new PrismaToothRecordRepository(prisma, tenantContext);
    const timeline = await inTenant(() => repo.listByTooth(patientId, '11'));
    expect(timeline).toHaveLength(TOOTH_TIMELINE_LIMIT);
    expect(timeline[0].recordedAt).toEqual(minutes(n - 1));
    const all = await inTenant(() => repo.listByPatient(patientId));
    expect(all).toHaveLength(n);
  });

  it(`planes de un paciente: los ${PATIENT_PLANS_LIMIT} más recientes`, async () => {
    const n = PATIENT_PLANS_LIMIT + 1;
    await raw.treatmentPlan.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        patientId,
        createdAt: minutes(i),
      })),
    });
    const repo = new PrismaTreatmentPlanRepository(prisma, tenantContext);
    const plans = await inTenant(() => repo.listPlansByPatient(patientId));
    expect(plans).toHaveLength(PATIENT_PLANS_LIMIT);
    expect(plans[0].createdAt).toEqual(minutes(n - 1));
  });
});
