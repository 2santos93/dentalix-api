import { randomUUID } from 'node:crypto';
import { CatalogKind, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// SEC-004, capa DB: las FK de Postgres se chequean SALTANDO la RLS, así que una
// FK simple `x -> padre(id)` solo garantiza "el padre existe en ALGÚN tenant".
// Un INSERT con `tenantId` = el del contexto pasa el WITH CHECK de la RLS, y con
// la FK simple también pasaba aunque el padre fuera de otra clínica. Las FK
// compuestas `(tenantId, x) -> padre(tenantId, id)` lo hacen imposible.
//
// Cada caso inserta POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS) en el tenant A, apuntando a un padre del tenant B,
// y espera P2003 (violación de FK). `raw` (DIRECT_URL, owner) solo siembra el
// tenant B y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

interface Seeded {
  tenantId: string;
  patientId: string;
  locationId: string;
  planId: string;
  paymentPlanId: string;
  itemId: string;
  scheduleId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede' },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id },
  });
  const paymentPlan = await raw.paymentPlan.create({
    data: {
      tenantId,
      treatmentPlanId: plan.id,
      patientId: patient.id,
      currency: 'USD',
      totalToFinance: 100,
      installmentsCount: 1,
      periodicity: 'MONTHLY',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  const item = await raw.inventoryItem.create({
    data: { tenantId, locationId: location.id, name: 'Guantes', unit: 'caja' },
  });
  const schedule = await raw.locationSchedule.create({
    data: { tenantId, locationId: location.id },
  });
  return {
    tenantId,
    patientId: patient.id,
    locationId: location.id,
    planId: plan.id,
    paymentPlanId: paymentPlan.id,
    itemId: item.id,
    scheduleId: schedule.id,
  };
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  await raw.locationScheduleRange.deleteMany({ where });
  await raw.locationSchedule.deleteMany({ where });
  await raw.inventoryMovement.deleteMany({ where });
  await raw.inventoryItem.deleteMany({ where });
  await raw.installment.deleteMany({ where });
  await raw.paymentPlan.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.toothRecord.deleteMany({ where });
  await raw.clinicalEntry.deleteMany({ where });
  await raw.medicalHistoryVersion.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const FK_VIOLATION = { code: 'P2003' };

describe('FK compuestas por tenant: rechazan referencias cruzadas (SEC-004, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('fk-compuesta-a');
    b = await seedClinic('fk-compuesta-b');
  });

  afterAll(async () => {
    await cleanup([a.tenantId, b.tenantId]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  /** Inserta como la clínica A (RLS activa): `tenantId` siempre es el de A. */
  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  describe('hijos de patients', () => {
    it('treatment_plans: no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlan.create({
            data: { tenantId: a.tenantId, patientId: b.patientId },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('medical_history_versions: no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.medicalHistoryVersion.create({
            data: { tenantId: a.tenantId, patientId: b.patientId, version: 1 },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('clinical_entries: no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntry.create({
            data: {
              tenantId: a.tenantId,
              patientId: b.patientId,
              entryDate: new Date(),
              notes: 'x',
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('tooth_records: no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.toothRecord.create({
            data: {
              tenantId: a.tenantId,
              patientId: b.patientId,
              toothNumber: '11',
              kind: CatalogKind.DIAGNOSIS,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('control: con el paciente de la propia clínica el INSERT pasa', async () => {
      const created = await asA((tx) =>
        tx.clinicalEntry.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            entryDate: new Date(),
            notes: 'ok',
          },
        }),
      );
      expect(created.tenantId).toBe(a.tenantId);
    });
  });

  describe('resto de FK que ya existían como simples', () => {
    it('treatment_plan_items.planId: no admite el plan de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.create({
            data: {
              tenantId: a.tenantId,
              planId: b.planId,
              toothNumber: '11',
              catalogItemId: randomUUID(),
              price: 10,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('payments: no admite el plan de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.payment.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              treatmentPlanId: b.planId,
              patientId: b.patientId,
              amount: 10,
              currency: 'USD',
              paidAt: new Date(),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('payments: no admite un patientId distinto del paciente del plan', async () => {
      const otherPatient = await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Otro', lastName: 'A' },
      });
      await expect(
        asA((tx) =>
          tx.payment.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              treatmentPlanId: a.planId,
              patientId: otherPatient.id,
              amount: 10,
              currency: 'USD',
              paidAt: new Date(),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('payments: no admite la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.payment.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              treatmentPlanId: a.planId,
              patientId: a.patientId,
              amount: 10,
              currency: 'USD',
              paidAt: new Date(),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('payment_plans: no admite el plan de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.paymentPlan.create({
            data: {
              tenantId: a.tenantId,
              treatmentPlanId: b.planId,
              patientId: b.patientId,
              currency: 'USD',
              totalToFinance: 100,
              installmentsCount: 1,
              periodicity: 'MONTHLY',
              startDate: new Date(),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('installments: no admite el plan de pagos de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.installment.create({
            data: {
              tenantId: a.tenantId,
              paymentPlanId: b.paymentPlanId,
              sequence: 1,
              dueDate: new Date(),
              amount: 100,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('appointments.locationId: no admite la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.appointment.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              patientId: a.patientId,
              providerId: randomUUID(),
              start: new Date('2030-01-01T10:00:00.000Z'),
              end: new Date('2030-01-01T10:30:00.000Z'),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('inventory_items.locationId: no admite la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.inventoryItem.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              name: 'Cruzado',
              unit: 'u',
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('inventory_movements: no admite el ítem ni la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.inventoryMovement.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              itemId: b.itemId,
              type: 'IN',
              quantity: 1,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        asA((tx) =>
          tx.inventoryMovement.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              itemId: a.itemId,
              type: 'IN',
              quantity: 1,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('location_schedule_ranges.scheduleId: no admite el horario de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.locationScheduleRange.create({
            data: {
              tenantId: a.tenantId,
              scheduleId: b.scheduleId,
              weekday: 1,
              startMinute: 540,
              endMinute: 600,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });
});
