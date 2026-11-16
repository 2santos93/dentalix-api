import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaLabRepository } from '../src/modules/lab-orders/infrastructure/prisma-lab.repository';
import type { DocumentTypeNamesReader } from '../src/modules/patients/domain/ports/document-type-names-repository.port';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants, purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-017, capa DB del laboratorio dental: RLS FORCE (otra clínica no ve ni
// modifica nada), FK compuestas por clínica y paciente (ítem, cita, servicio
// del mismo laboratorio, orden corregida), guarda de inmutabilidad («nunca se
// borra, se anula»; tras «Enviada» solo cambian la fecha prometida y la cita),
// número correlativo por clínica, índice de pendientes con su predicado, la
// lista de la sede por SQL y la fusión de pacientes (DX-266). Se escribe como
// la app (runWithTenant, dentalix_app); `raw` (DIRECT_URL, owner) siembra y
// limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaLabRepository(prisma, tenantContext, {
  get: () => Promise.resolve({}),
} as unknown as DocumentTypeNamesReader);

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
  membershipId: string;
  patients: string[];
  itemId: string;
  appointmentId: string;
  labId: string;
  serviceId: string;
  otherLabServiceId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const patients: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: `Paciente${i}`,
        lastName: subdomain,
        phone: `+58412000001${i}`,
      },
    });
    patients.push(p.id);
  }
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'dx017',
      kind: 'PROCEDURE',
      labelEs: 'Corona de zirconio',
      color: '#123456',
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: patients[0], currency: 'USD' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      catalogItemId: catalog.id,
      toothNumber: '16',
      price: 300,
    },
  });
  const start = new Date('2026-12-02T14:00:00.000Z');
  const appointment = await raw.appointment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patients[0],
      providerId: user.id,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  });
  const lab = await raw.dentalLab.create({
    data: { tenantId: tenant.id, name: 'Laboratorio Dental Caracas' },
  });
  const service = await raw.dentalLabService.create({
    data: {
      tenantId: tenant.id,
      labId: lab.id,
      name: 'Corona zirconio',
      leadTimeBusinessDays: 5,
    },
  });
  const otherLab = await raw.dentalLab.create({
    data: { tenantId: tenant.id, name: 'ProtoLab Valencia' },
  });
  const otherService = await raw.dentalLabService.create({
    data: {
      tenantId: tenant.id,
      labId: otherLab.id,
      name: 'Férula de descarga',
      leadTimeBusinessDays: 3,
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    membershipId: membership.id,
    patients,
    itemId: item.id,
    appointmentId: appointment.id,
    labId: lab.id,
    serviceId: service.id,
    otherLabServiceId: otherService.id,
  };
}

function orderData(
  c: Clinic,
  extra: Partial<Prisma.DentalLabOrderUncheckedCreateInput> = {},
): Prisma.DentalLabOrderUncheckedCreateInput {
  return {
    tenantId: c.tenantId,
    locationId: c.locationId,
    patientId: c.patients[0],
    professionalMembershipId: c.membershipId,
    labId: c.labId,
    serviceId: c.serviceId,
    description: 'Corona de zirconio',
    toothNumbers: ['16'],
    shade: 'A2',
    createdById: c.userId,
    number: 0,
    ...extra,
  };
}

const asApp = <T>(
  c: Clinic,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(c.tenantId, fn);

const inContext = <T>(c: Clinic, fn: () => Promise<T>) =>
  tenantContext.run(c.tenantId, undefined, fn);

describe('dental_labs / dental_lab_services / dental_lab_orders (DX-017, int)', () => {
  let a: Clinic;
  let b: Clinic;
  let orderA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    // Restos de una corrida cortada.
    await purgeTenantsBySubdomain(raw, ['dx017-int-a', 'dx017-int-b']);
    await raw.user.deleteMany({
      where: { email: { in: ['dr@dx017-int-a.test', 'dr@dx017-int-b.test'] } },
    });
    a = await seedClinic('dx017-int-a');
    b = await seedClinic('dx017-int-b');
    orderA = (
      await asApp(a, (tx) =>
        tx.dentalLabOrder.create({
          data: orderData(a, {
            treatmentPlanItemId: a.itemId,
            appointmentId: a.appointmentId,
          }),
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await purgeTenants(raw, [a.tenantId, b.tenantId]);
    await raw.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('RLS FORCE', () => {
    it('las tres tablas tienen RLS activada y forzada', async () => {
      const rows = await raw.$queryRaw<
        { relname: string; on: boolean; forced: boolean }[]
      >`SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced
          FROM pg_class
         WHERE relname IN ('dental_labs', 'dental_lab_services', 'dental_lab_orders')
         ORDER BY 1`;
      expect(rows).toEqual([
        { relname: 'dental_lab_orders', on: true, forced: true },
        { relname: 'dental_lab_services', on: true, forced: true },
        { relname: 'dental_labs', on: true, forced: true },
      ]);
    });

    it('B no ve el laboratorio, el servicio ni la orden de A', async () => {
      await expect(
        asApp(b, (tx) => tx.dentalLab.findMany({ where: { id: a.labId } })),
      ).resolves.toEqual([]);
      await expect(
        asApp(b, (tx) =>
          tx.dentalLabService.findMany({ where: { id: a.serviceId } }),
        ),
      ).resolves.toEqual([]);
      await expect(
        asApp(b, (tx) => tx.dentalLabOrder.findMany({ where: { id: orderA } })),
      ).resolves.toEqual([]);
    });

    it('B no modifica la orden ni el laboratorio de A (0 filas) y nada cambia', async () => {
      await expect(
        asApp(b, (tx) =>
          tx.dentalLabOrder.updateMany({
            where: { id: orderA },
            data: { description: 'Otra cosa' },
          }),
        ),
      ).resolves.toEqual({ count: 0 });
      await expect(
        asApp(b, (tx) =>
          tx.dentalLab.updateMany({
            where: { id: a.labId },
            data: { active: false },
          }),
        ),
      ).resolves.toEqual({ count: 0 });
      const row = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: orderA },
      });
      expect(row.description).toBe('Corona de zirconio');
      expect(
        (await raw.dentalLab.findUniqueOrThrow({ where: { id: a.labId } }))
          .active,
      ).toBe(true);
    });

    it('B no inserta una orden con el tenant de A', async () => {
      await expect(
        asApp(b, (tx) => tx.dentalLabOrder.create({ data: orderData(a) })),
      ).rejects.toThrow(/row-level security|violates/);
    });
  });

  describe('FK compuestas por clínica y paciente', () => {
    it('un ítem del plan de OTRO paciente de la misma clínica se rechaza', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, {
              patientId: a.patients[1],
              treatmentPlanItemId: a.itemId,
            }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_plan_item_fkey|Foreign key/);
    });

    it('un ítem o una cita de OTRA clínica se rechazan', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, { treatmentPlanItemId: b.itemId }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_plan_item_fkey|Foreign key/);
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, { appointmentId: b.appointmentId }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_appointment_fkey|Foreign key/);
    });

    it('una cita de otro paciente se rechaza', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, {
              patientId: a.patients[2],
              appointmentId: a.appointmentId,
            }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_appointment_fkey|Foreign key/);
    });

    it('un servicio de otro laboratorio y un laboratorio de otra clínica se rechazan', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, { serviceId: a.otherLabServiceId }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_service_fkey|Foreign key/);
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, { labId: b.labId, serviceId: null }),
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_lab_fkey|Foreign key/);
    });

    it('la orden corregida tiene que ser del MISMO paciente (trigger)', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, {
              patientId: a.patients[1],
              replacesOrderId: orderA,
            }),
          }),
        ),
      ).rejects.toThrow(/la orden corregida es de otro paciente/);
      const fix = await asApp(a, (tx) =>
        tx.dentalLabOrder.create({
          data: orderData(a, { replacesOrderId: orderA }),
        }),
      );
      expect(fix.replacesOrderId).toBe(orderA);
    });

    it('el servicio de otra clínica se rechaza al crear', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabService.create({
            data: {
              tenantId: a.tenantId,
              labId: b.labId,
              name: 'Intrusa',
              leadTimeBusinessDays: 1,
            },
          }),
        ),
      ).rejects.toThrow(/dental_lab_services_lab_fkey|Foreign key/);
    });
  });

  describe('número, CHECK y únicos', () => {
    it('el número es correlativo por clínica (lo pone el trigger)', async () => {
      const first = await asApp(b, (tx) =>
        tx.dentalLabOrder.create({ data: orderData(b, { number: 999 }) }),
      );
      const second = await asApp(b, (tx) =>
        tx.dentalLabOrder.create({ data: orderData(b) }),
      );
      expect([first.number, second.number]).toEqual([1, 2]);
      const ofA = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: orderA },
      });
      expect(ofA.number).toBe(1);
    });

    it('nace en borrador: no se inserta enviada ni anulada', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.create({
            data: orderData(a, { sentAt: new Date(), sentById: a.userId }),
          }),
        ),
      ).rejects.toThrow(/una orden nace en borrador/);
    });

    it('dientes FDI sin repetir y textos dentro de sus topes', async () => {
      for (const extra of [
        { toothNumbers: ['16', '16'] },
        { toothNumbers: ['19'] },
        { description: '   ' },
        { shade: 'x'.repeat(41) },
        { instructions: 'x'.repeat(2001) },
      ]) {
        await expect(
          asApp(a, (tx) =>
            tx.dentalLabOrder.create({ data: orderData(a, extra) }),
          ),
        ).rejects.toThrow(/dental_lab_orders_values_check/);
      }
    });

    it('no se recibe sin enviar ni se revisa sin recibir; pares fecha/autor; anulación completa', async () => {
      const draft = await asApp(a, (tx) =>
        tx.dentalLabOrder.create({ data: orderData(a) }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: draft.id },
            data: { receivedAt: new Date(), receivedById: a.userId },
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_steps_check/);
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: draft.id },
            data: { sentAt: new Date() },
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_pairs_check/);
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: draft.id },
            data: { cancelledAt: new Date(), cancelledById: a.userId },
          }),
        ),
      ).rejects.toThrow(/dental_lab_orders_cancel_check/);
    });

    it('el nombre del laboratorio es único por clínica sin distinguir mayúsculas; otra clínica puede repetirlo', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.dentalLab.create({
            data: {
              tenantId: a.tenantId,
              name: '  laboratorio dental CARACAS ',
            },
          }),
        ),
      ).rejects.toThrow(/dental_labs_tenant_name_key|Unique constraint/);
      // b ya tiene uno con el mismo nombre (seedClinic): no choca con el de a.
      expect(
        await raw.dentalLab.count({
          where: { name: 'Laboratorio Dental Caracas' },
        }),
      ).toBeGreaterThanOrEqual(2);
    });
  });

  describe('guarda: nunca se borra, se anula; inalterable tras «Enviada»', () => {
    it('la app no borra órdenes, laboratorios ni servicios', async () => {
      for (const sql of [
        Prisma.sql`DELETE FROM "dental_lab_orders" WHERE "id" = ${orderA}::uuid`,
        Prisma.sql`DELETE FROM "dental_labs" WHERE "id" = ${a.labId}::uuid`,
        Prisma.sql`DELETE FROM "dental_lab_services" WHERE "id" = ${a.serviceId}::uuid`,
        Prisma.sql`TRUNCATE "dental_lab_orders"`,
      ]) {
        await expect(asApp(a, (tx) => tx.$executeRaw(sql))).rejects.toThrow(
          /permission denied|no se borra/,
        );
      }
      expect(await raw.dentalLabOrder.count({ where: { id: orderA } })).toBe(1);
    });

    it('ni el dueño de la tabla borra una orden (solo un superusuario)', async () => {
      const [{ su }] = await raw.$queryRaw<{ su: boolean }[]>`
        SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`;
      if (su) return; // la purga de test corre como superusuario
      await expect(
        raw.dentalLabOrder.delete({ where: { id: orderA } }),
      ).rejects.toThrow(/no se borra, se anula/);
    });

    it('en borrador el contenido cambia; tras enviar solo cambian la fecha prometida y la cita', async () => {
      const order = await asApp(a, (tx) =>
        tx.dentalLabOrder.create({ data: orderData(a) }),
      );
      await asApp(a, (tx) =>
        tx.dentalLabOrder.update({
          where: { id: order.id },
          data: { shade: 'A3', instructions: 'Contacto firme' },
        }),
      );
      await asApp(a, (tx) =>
        tx.dentalLabOrder.update({
          where: { id: order.id },
          data: { sentAt: new Date(), sentById: a.userId },
        }),
      );
      for (const data of [
        { shade: 'B1' },
        { toothNumbers: ['17'] },
        { labId: a.labId, serviceId: null },
        { description: 'Otra' },
      ]) {
        await expect(
          asApp(a, (tx) =>
            tx.dentalLabOrder.update({ where: { id: order.id }, data }),
          ),
        ).rejects.toThrow(/una orden enviada no cambia/);
      }
      const moved = await asApp(a, (tx) =>
        tx.dentalLabOrder.update({
          where: { id: order.id },
          data: { dueOn: day('2026-12-01'), appointmentId: a.appointmentId },
        }),
      );
      expect(moved.dueOn).toEqual(day('2026-12-01'));
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: order.id },
            data: { sentAt: new Date(Date.now() + 1000) },
          }),
        ),
      ).rejects.toThrow(/no cambia ni se quita/);
    });

    it('lo inmutable no cambia nunca (número, sede, autor) y una anulada ya no se toca', async () => {
      const order = await asApp(a, (tx) =>
        tx.dentalLabOrder.create({ data: orderData(a) }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: order.id },
            data: { number: 9999 },
          }),
        ),
      ).rejects.toThrow(/no cambian/);
      await asApp(a, (tx) =>
        tx.dentalLabOrder.update({
          where: { id: order.id },
          data: {
            cancelledAt: new Date(),
            cancelledById: a.userId,
            cancelReason: 'El paciente pospone el tratamiento',
          },
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.dentalLabOrder.update({
            where: { id: order.id },
            data: { dueOn: day('2026-12-01') },
          }),
        ),
      ).rejects.toThrow(/una orden anulada no se modifica/);
    });

    it('un laboratorio no cambia de clínica', async () => {
      await expect(
        raw.dentalLab.update({
          where: { id: a.labId },
          data: { tenantId: b.tenantId },
        }),
      ).rejects.toThrow(/no cambian|Foreign key|violates/);
    });
  });

  describe('trabajos pendientes de la sede', () => {
    it('el índice parcial de pendientes existe con su predicado', async () => {
      const [idx] = await raw.$queryRaw<{ def: string }[]>`
        SELECT indexdef AS def FROM pg_indexes
         WHERE indexname = 'dental_lab_orders_pending_idx'`;
      expect(idx.def).toContain('("tenantId", "locationId", "dueOn")');
      expect(idx.def).toMatch(
        /WHERE \(\("receivedAt" IS NULL\) AND \("cancelledAt" IS NULL\)\)/,
      );
    });

    it('«solo atrasadas»: fecha prometida vencida en la sede, sin recibir ni anular; atrasadas primero', async () => {
      const make = (
        extra: Partial<Prisma.DentalLabOrderUncheckedCreateInput>,
      ) =>
        asApp(b, (tx) =>
          tx.dentalLabOrder.create({ data: orderData(b, extra) }),
        );
      const late = await make({ dueOn: day('2026-11-17') });
      const soon = await make({ dueOn: day('2026-11-25') });
      const received = await make({ dueOn: day('2026-11-10') });
      await asApp(b, async (tx) => {
        await tx.dentalLabOrder.update({
          where: { id: received.id },
          data: {
            sentAt: new Date('2026-11-02T12:00:00Z'),
            sentById: b.userId,
          },
        });
        await tx.dentalLabOrder.update({
          where: { id: received.id },
          data: {
            receivedAt: new Date('2026-11-09T12:00:00Z'),
            receivedById: b.userId,
          },
        });
      });
      const base = {
        locationId: b.locationId,
        statuses: [],
        today: '2026-11-20',
        page: 1,
        pageSize: 50,
      };
      const overdue = await inContext(b, () =>
        repo.listOrderIds({ ...base, overdue: true }),
      );
      expect(overdue).toEqual({ ids: [late.id], total: 1 });
      const all = await inContext(b, () =>
        repo.listOrderIds({ ...base, overdue: false }),
      );
      expect(all.ids[0]).toBe(late.id);
      expect(all.ids.indexOf(soon.id)).toBeGreaterThan(0);
      const views = await inContext(b, () =>
        repo.views([late.id], new Date('2026-11-20T15:00:00.000Z')),
      );
      expect(views[0]).toMatchObject({
        status: 'DRAFT',
        overdue: true,
        daysOverdue: 3,
        lab: { name: 'Laboratorio Dental Caracas' },
        service: { name: 'Corona zirconio', leadTimeBusinessDays: 5 },
      });
      const sentOnly = await inContext(b, () =>
        repo.listOrderIds({ ...base, statuses: ['RECEIVED'], overdue: false }),
      );
      expect(sentOnly.ids).toEqual([received.id]);
      // A no aparece en la lista de B ni pidiendo la sede de A.
      const foreign = await inContext(b, () =>
        repo.listOrderIds({
          ...base,
          locationId: a.locationId,
          overdue: false,
        }),
      );
      expect(foreign).toEqual({ ids: [], total: 0 });
    });

    it('la vista del ítem del plan lleva su procedimiento y la de la cita su hora', async () => {
      const [view] = await inContext(a, () => repo.views([orderA], new Date()));
      expect(view).toMatchObject({
        treatmentPlanItem: {
          id: a.itemId,
          toothNumber: '16',
          procedureName: 'Corona de zirconio',
        },
        appointment: { id: a.appointmentId },
        professional: { membershipId: a.membershipId, userId: a.userId },
      });
    });
  });

  describe('fusión de pacientes (DX-266)', () => {
    it('la orden (con su ítem y su cita) pasa al conservado: la guarda abre la puerta', async () => {
      await asApp(
        a,
        (tx) =>
          tx.$queryRaw`SELECT dx_merge_patients(${a.patients[0]}::uuid, ${a.patients[3]}::uuid, ${a.userId}::uuid)`,
      );
      const moved = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: orderA },
      });
      expect(moved.patientId).toBe(a.patients[3]);
      expect(moved.treatmentPlanItemId).toBe(a.itemId);
      expect(moved.appointmentId).toBe(a.appointmentId);
      expect(moved.description).toBe('Corona de zirconio');
    });
  });
});
