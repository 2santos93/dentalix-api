import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaInventoryRepository } from '../src/modules/inventory/infrastructure/repositories/prisma-inventory.repository';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import { PrismaToothRecordRepository } from '../src/modules/odontogram/infrastructure/repositories/prisma-tooth-record.repository';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// Por encima de cualquier tope «razonable» que se pudiera volver a poner sin
// paginación: estos listados tienen que llegar COMPLETOS.
const MANY = 501;

// DX-043 (revisión, B1/M3): los listados por padre de datos clínicos y de
// inventario NO se cortan en silencio: la respuesta es un array sin `total`
// ni aviso, así que un tope ocultaría historia clínica sin que nadie lo sepa.
// Se comprueba que llegan completos y en orden (más reciente primero). `raw` (DIRECT_URL, owner) siembra y limpia;
// las lecturas van por los repositorios reales (rol dentalix_app, RLS).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const BASE = Date.UTC(2026, 0, 1);
const minutes = (n: number) => new Date(BASE + n * 60_000);

describe('Listados por padre completos, sin topes silenciosos (DX-043, int)', () => {
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
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
      })
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

  it('movimientos de un insumo: todos, y cuadran con el stock', async () => {
    const n = MANY;
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
    expect(movements).toHaveLength(n);
    expect(movements[0].occurredAt).toEqual(minutes(n - 1));
    expect(movements.at(-1)?.occurredAt).toEqual(minutes(0));
    expect(await inTenant(() => repo.sumSignedQuantity(itemId))).toBe(n);
  });

  it('evoluciones de un paciente: todas', async () => {
    const n = MANY;
    await raw.clinicalEntry.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        patientId,
        entryDate: minutes(i),
        notes: `Evolución ${i}`,
        performedById: patientId,
      })),
    });
    const repo = new PrismaClinicalEntryRepository(prisma, tenantContext);
    const entries = await inTenant(() => repo.listByPatient(patientId));
    expect(entries).toHaveLength(n);
    expect(entries[0].entryDate).toEqual(minutes(n - 1));
    expect(entries.at(-1)?.notes).toBe('Evolución 0');
  });

  it('línea de tiempo de un diente: toda', async () => {
    const n = MANY;
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
    expect(timeline).toHaveLength(n);
    expect(timeline[0].recordedAt).toEqual(minutes(n - 1));
    expect(timeline.at(-1)?.recordedAt).toEqual(minutes(0));
    const all = await inTenant(() => repo.listByPatient(patientId));
    expect(all).toHaveLength(n);
  });

  it('planes de un paciente: todos', async () => {
    const n = MANY;
    await raw.treatmentPlan.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId,
        patientId,
        currency: 'USD',
        createdAt: minutes(i),
      })),
    });
    const repo = new PrismaTreatmentPlanRepository(prisma, tenantContext);
    const plans = await inTenant(() => repo.listPlansByPatient(patientId));
    expect(plans).toHaveLength(n);
    expect(plans[0].createdAt).toEqual(minutes(n - 1));
    expect(plans.at(-1)?.createdAt).toEqual(minutes(0));
  });
});
