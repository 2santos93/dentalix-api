import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-012, capa DB de treatment_plan_acceptances y del congelado de ítems. Cada
// caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'a'.repeat(64);

interface Seeded {
  tenantId: string;
  userId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  catalogItemId: string;
  /** Plan con aceptación firmada. */
  signedPlanId: string;
  signedItemId: string;
  /** Plan sin firmar. */
  draftPlanId: string;
  draftItemId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: `Dra ${subdomain}`,
    },
  });
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede principal' },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const other = await raw.patient.create({
    data: { tenantId, firstName: 'Otra', lastName: subdomain },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  const signed = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id, currency: 'USD' },
  });
  const signedItem = await raw.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: signed.id,
      toothNumber: '11',
      catalogItemId: catalog.id,
      price: 100,
      discount: 10,
      status: 'ACCEPTED',
    },
  });
  const draft = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id, currency: 'USD' },
  });
  const draftItem = await raw.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: draft.id,
      toothNumber: '21',
      catalogItemId: catalog.id,
      price: 50,
    },
  });
  return {
    tenantId,
    userId: user.id,
    locationId: location.id,
    patientId: patient.id,
    otherPatientId: other.id,
    catalogItemId: catalog.id,
    signedPlanId: signed.id,
    signedItemId: signedItem.id,
    draftPlanId: draft.id,
    draftItemId: draftItem.id,
  };
}

function acceptanceData(
  s: Seeded,
  extra: Partial<Prisma.TreatmentPlanAcceptanceUncheckedCreateInput> = {},
): Prisma.TreatmentPlanAcceptanceUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    planId: s.signedPlanId,
    patientId: s.patientId,
    locationId: s.locationId,
    signerName: 'Ana',
    signature: PNG,
    content: { version: 1 },
    contentHash: HASH,
    acceptanceHash: HASH,
    acceptedAt: new Date(),
    acceptedById: s.userId,
    ...extra,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const where = { tenantId: { in: seeds.map((s) => s.tenantId) } };
  // Sin `app.current_tenant` (conexión owner): los triggers dejan borrar.
  await raw.treatmentPlanAcceptance.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({
    where: { id: { in: seeds.map((s) => s.tenantId) } },
  });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
}

const FK_VIOLATION = { code: 'P2003' };
const UNIQUE_VIOLATION = { code: 'P2002' };
const RESTRICT = /23001|aceptado y firmado|inmutable/;
const CHECK = /23514|check constraint/;

describe('treatment_plan_acceptances: FK compuestas, RLS, inmutabilidad y congelado (DX-012, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('tpa-int-a');
    b = await seedClinic('tpa-int-b');
    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.treatmentPlanAcceptance.create({ data: acceptanceData(a) }),
    );
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  describe('FK compuestas por tenant', () => {
    it('no admite el plan de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanAcceptance.create({
            data: acceptanceData(a, { planId: b.draftPlanId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('no admite el plan de otro paciente de la misma clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanAcceptance.create({
            data: acceptanceData(a, {
              planId: a.draftPlanId,
              patientId: a.otherPatientId,
            }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('no admite la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanAcceptance.create({
            data: acceptanceData(a, {
              planId: a.draftPlanId,
              locationId: b.locationId,
            }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('RLS', () => {
    it('la otra clínica no ve la aceptación', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.findMany(),
      );
      expect(seen).toEqual([]);
      const own = await asA((tx) => tx.treatmentPlanAcceptance.findMany());
      expect(own).toHaveLength(1);
    });

    it('no se puede escribir una fila con el tenant de otra clínica', async () => {
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.treatmentPlanAcceptance.create({
            data: acceptanceData(a, { planId: a.draftPlanId }),
          }),
        ),
      ).rejects.toThrow(/row-level security|42501/);
    });
  });

  describe('una por plan e inmutable', () => {
    it('una segunda aceptación del mismo plan choca con el índice único', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanAcceptance.create({ data: acceptanceData(a) }),
        ),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
    });

    it('UPDATE rechazado (también para el owner)', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanAcceptance.updateMany({
            data: { signerName: 'Otra' },
          }),
        ),
      ).rejects.toThrow(RESTRICT);
      await expect(
        raw.treatmentPlanAcceptance.updateMany({
          where: { tenantId: a.tenantId },
          data: { signerName: 'Otra' },
        }),
      ).rejects.toThrow(RESTRICT);
    });

    it('DELETE rechazado dentro de la app (contexto de tenant)', async () => {
      await expect(
        // SQL directo: el proxy de la app ya prohíbe deleteMany (no-hard-delete);
        // esto prueba la red de la base por debajo.
        asA((tx) => tx.$executeRaw`DELETE FROM "treatment_plan_acceptances"`),
      ).rejects.toThrow(RESTRICT);
    });

    it('CHECK: hashes en hex de 64, firma y nombre no vacíos', async () => {
      for (const extra of [
        { contentHash: 'xyz' },
        { acceptanceHash: 'A'.repeat(64) },
        { signerName: '  ' },
        { signature: '' },
      ]) {
        await expect(
          asA((tx) =>
            tx.treatmentPlanAcceptance.create({
              data: acceptanceData(a, { planId: a.draftPlanId, ...extra }),
            }),
          ),
        ).rejects.toThrow(CHECK);
      }
    });
  });

  describe('ítems de un plan aceptado: congelados', () => {
    it('no admite ítems nuevos', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.create({
            data: {
              tenantId: a.tenantId,
              planId: a.signedPlanId,
              toothNumber: '12',
              catalogItemId: a.catalogItemId,
              price: 10,
            },
          }),
        ),
      ).rejects.toThrow(RESTRICT);
    });

    it.each([
      ['price', { price: 1 }],
      ['discount', { discount: 0 }],
      ['surfaces', { surfaces: ['MESIAL' as const] }],
      ['notes', { notes: 'otra' }],
      ['deletedAt (retirar)', { deletedAt: new Date() }],
      ['status → PROPOSED', { status: 'PROPOSED' as const }],
    ])('no admite cambiar %s', async (_label, data) => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({ where: { id: a.signedItemId }, data }),
        ),
      ).rejects.toThrow(RESTRICT);
    });

    it('sí admite avanzar el estado (ACCEPTED → DONE → ACCEPTED)', async () => {
      await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: a.signedItemId },
          data: { status: 'DONE' },
        }),
      );
      const back = await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: a.signedItemId },
          data: { status: 'ACCEPTED' },
        }),
      );
      expect(back.status).toBe('ACCEPTED');
    });

    it('DELETE en duro rechazado dentro de la app', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "treatment_plan_items" WHERE "id" = ${a.signedItemId}::uuid`,
        ),
      ).rejects.toThrow(RESTRICT);
    });

    it('el plan aceptado no cambia de moneda ni vuelve a borrador; sí se cierra', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlan.update({
            where: { id: a.signedPlanId },
            data: { currency: 'EUR' },
          }),
        ),
      ).rejects.toThrow(RESTRICT);
      await asA((tx) =>
        tx.treatmentPlan.update({
          where: { id: a.signedPlanId },
          data: { status: 'ACCEPTED', notes: 'firmado' },
        }),
      );
      await expect(
        asA((tx) =>
          tx.treatmentPlan.update({
            where: { id: a.signedPlanId },
            data: { status: 'DRAFT' },
          }),
        ),
      ).rejects.toThrow(RESTRICT);
    });

    it('un plan SIN firma sigue editable como siempre', async () => {
      await asA(async (tx) => {
        await tx.treatmentPlanItem.update({
          where: { id: a.draftItemId },
          data: { price: 60, discount: 5, surfaces: ['OCCLUSAL'], notes: 'x' },
        });
        await tx.treatmentPlan.update({
          where: { id: a.draftPlanId },
          data: { currency: 'EUR', status: 'DRAFT' },
        });
        await tx.treatmentPlanItem.create({
          data: {
            tenantId: a.tenantId,
            planId: a.draftPlanId,
            toothNumber: '22',
            catalogItemId: a.catalogItemId,
            price: 10,
          },
        });
      });
    });
  });

  describe('descuento', () => {
    it.each([
      ['mayor que el precio', { price: 10, discount: 10.01 }],
      ['negativo', { price: 10, discount: -1 }],
    ])('CHECK: rechaza un descuento %s', async (_label, data) => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({ where: { id: a.draftItemId }, data }),
        ),
      ).rejects.toThrow(CHECK);
    });
  });

  describe('concurrencia', () => {
    it('un ítem añadido mientras se firma espera a la firma y luego choca con ella', async () => {
      let releaseAccept!: () => void;
      const acceptHolds = new Promise<void>((resolve) => {
        releaseAccept = resolve;
      });
      let lockTaken!: () => void;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });

      // La aceptación de la app: bloquea el plan FOR UPDATE, inserta y espera.
      const accepting = asA(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "treatment_plans" WHERE "id" = ${a.draftPlanId}::uuid FOR UPDATE`;
        await tx.treatmentPlanAcceptance.create({
          data: acceptanceData(a, { planId: a.draftPlanId }),
        });
        lockTaken();
        await acceptHolds;
      });
      await locked;

      // Otro usuario añade un ítem a la vez: su trigger espera al COMMIT.
      const adding = asA((tx) =>
        tx.treatmentPlanItem.create({
          data: {
            tenantId: a.tenantId,
            planId: a.draftPlanId,
            toothNumber: '23',
            catalogItemId: a.catalogItemId,
            price: 10,
          },
        }),
      );
      const settled = adding.then(
        () => 'added',
        (error: unknown) => (error instanceof Error ? error.message : 'error'),
      );
      releaseAccept();
      await accepting;
      expect(await settled).toMatch(RESTRICT);
    });
  });
});
