import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  PrismaClient,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaStaffRepository } from '../src/modules/staff/infrastructure/repositories/prisma-staff.repository';
import { UpdateStaffUseCase } from '../src/modules/staff/application/use-cases/update-staff.use-case';
import { DeactivateStaffUseCase } from '../src/modules/staff/application/use-cases/deactivate-staff.use-case';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';

// DX-042: carreras que la base y los repositorios cierran ahora en UNA
// transacción (DB-012 último ADMIN, DB-013 espejo DONE → odontograma, DB-014
// idempotencia del abono). Cada caso lanza dos escrituras A LA VEZ por la misma
// ruta que la app (repositorios reales, rol dentalix_app bajo RLS) y comprueba
// el estado final. Se repite varias veces: con la versión anterior (comprobar
// y escribir en transacciones distintas) bastaba una vuelta para romperlo.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'domain-races';
const ROUNDS = 5;

interface Seeded {
  tenantId: string;
  patientId: string;
  planId: string;
}

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const tenantId = tenant.id;
  await raw.location.create({ data: { tenantId, name: 'Sede principal' } });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Carreras' },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id, currency: 'USD' },
  });
  return { tenantId, patientId: patient.id, planId: plan.id };
}

async function cleanup(tenantId: string): Promise<void> {
  const where = { tenantId };
  const memberships = await raw.clinicMembership.findMany({
    where,
    select: { userId: true },
  });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.toothRecord.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.user.deleteMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: tenantId } });
}

describe('Carreras cerradas en una transacción (DX-042, int)', () => {
  let s: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    s = await seed();
  });

  afterAll(async () => {
    await cleanup(s.tenantId);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(s.tenantId, fn);
  }

  describe('último ADMIN (DB-012)', () => {
    const staff = new PrismaStaffRepository(prisma);
    const update = new UpdateStaffUseCase(staff);
    const deactivate = new DeactivateStaffUseCase(staff);

    async function twoAdmins(round: number): Promise<[string, string]> {
      await raw.clinicMembership.updateMany({
        where: { tenantId: s.tenantId },
        data: { deletedAt: new Date() },
      });
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const user = await raw.user.create({
          data: {
            email: `admin${n}-r${round}-${randomUUID()}@races.test`,
            passwordHash: 'x',
            fullName: `Admin ${n}`,
          },
        });
        await raw.clinicMembership.create({
          data: { tenantId: s.tenantId, userId: user.id, role: 'ADMIN' },
        });
        ids.push(user.id);
      }
      return [ids[0], ids[1]];
    }

    function activeAdmins(): Promise<number> {
      return raw.clinicMembership.count({
        where: { tenantId: s.tenantId, role: 'ADMIN', deletedAt: null },
      });
    }

    it('dos degradaciones concurrentes de los dos últimos ADMIN dejan 1 ADMIN', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const [a, b] = await twoAdmins(round);
        const results = await Promise.allSettled([
          inTenant(() =>
            update.execute({ userId: a, role: ClinicRole.DENTIST }),
          ),
          inTenant(() =>
            update.execute({ userId: b, role: ClinicRole.DENTIST }),
          ),
        ]);

        expect(await activeAdmins()).toBe(1);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      }
    });

    it('dos desactivaciones cruzadas concurrentes dejan 1 ADMIN', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const [a, b] = await twoAdmins(100 + round);
        const results = await Promise.allSettled([
          inTenant(() =>
            deactivate.execute({ userId: a, requestingUserId: b }),
          ),
          inTenant(() =>
            deactivate.execute({ userId: b, requestingUserId: a }),
          ),
        ]);

        expect(await activeAdmins()).toBe(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      }
    });

    it('una degradación y una desactivación concurrentes dejan 1 ADMIN', async () => {
      const [a, b] = await twoAdmins(200);
      await Promise.allSettled([
        inTenant(() => update.execute({ userId: a, role: ClinicRole.DENTIST })),
        inTenant(() => deactivate.execute({ userId: b, requestingUserId: a })),
      ]);
      expect(await activeAdmins()).toBe(1);
    });
  });

  describe('espejo DONE → odontograma (DB-013)', () => {
    const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);

    async function proposedItem(): Promise<string> {
      const item = await raw.treatmentPlanItem.create({
        data: {
          tenantId: s.tenantId,
          planId: s.planId,
          toothNumber: '16',
          catalogItemId: randomUUID(),
          price: 120,
        },
      });
      return item.id;
    }

    function mirroredRecords(itemId: string): Promise<number> {
      return raw.toothRecord.count({ where: { sourcePlanItemId: itemId } });
    }

    it('dos PATCH status=DONE concurrentes dejan exactamente 1 tooth_record', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const itemId = await proposedItem();
        const mirror = { patientId: s.patientId, kind: CatalogKind.PROCEDURE };
        const results = await Promise.all([
          inTenant(() =>
            plans.updateItem(
              itemId,
              { status: TreatmentPlanItemStatus.DONE },
              mirror,
            ),
          ),
          inTenant(() =>
            plans.updateItem(
              itemId,
              { status: TreatmentPlanItemStatus.DONE },
              mirror,
            ),
          ),
        ]);

        expect(results.map((r) => r.status)).toEqual(['DONE', 'DONE']);
        expect(await mirroredRecords(itemId)).toBe(1);
      }
    });

    it('si el espejo falla, el ítem NO queda DONE (todo o nada)', async () => {
      const itemId = await proposedItem();
      // Un paciente que no es de la clínica: la FK compuesta del registro
      // rechaza el INSERT dentro de la misma transacción del cambio de estado.
      await expect(
        inTenant(() =>
          plans.updateItem(
            itemId,
            { status: TreatmentPlanItemStatus.DONE },
            { patientId: randomUUID(), kind: CatalogKind.PROCEDURE },
          ),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });

      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.status).toBe(TreatmentPlanItemStatus.PROPOSED);
      expect(await mirroredRecords(itemId)).toBe(0);
    });
  });

  describe('idempotencia del abono (DB-014)', () => {
    const payments = new PrismaPaymentRepository(prisma, tenantContext);

    function record(idempotencyKey: string, planId = s.planId) {
      return inTenant(() =>
        payments.create({
          treatmentPlanId: planId,
          patientId: s.patientId,
          amount: 50,
          currency: 'USD',
          paidAt: new Date('2026-10-01T00:00:00.000Z'),
          idempotencyKey,
        }),
      );
    }

    it('dos reintentos simultáneos con la misma clave devuelven el MISMO abono', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const key = randomUUID();
        const [first, second] = await Promise.all([record(key), record(key)]);

        expect(second.id).toBe(first.id);
        expect(
          await raw.payment.count({ where: { idempotencyKey: key } }),
        ).toBe(1);
      }
    });

    it('rechaza (404) un abono contra un plan retirado, aunque se validara antes', async () => {
      const plan = await raw.treatmentPlan.create({
        data: {
          tenantId: s.tenantId,
          patientId: s.patientId,
          currency: 'USD',
          deletedAt: new Date(),
        },
      });
      await expect(record(randomUUID(), plan.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
