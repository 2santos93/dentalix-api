import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-379 (porción C), capa DB de las columnas de la aceptación de un
// presupuesto vencido: CHECK de modo, motivo, nota y recotización, FK
// compuesta a la recotización (misma clínica, plan y paciente), RLS e
// inmutabilidad. Cada caso escribe POR LA MISMA RUTA que la app
// (runWithTenant, rol dentalix_app); `raw` (owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'a'.repeat(64);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);
const CHECK = /23514|check constraint/;
const FK_VIOLATION = { code: 'P2003' };

interface Seeded {
  tenantId: string;
  userId: string;
  locationId: string;
  patientId: string;
  catalogItemId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: `Dra ${subdomain}`,
    },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    locationId: location.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
  };
}

/** Un plan presentado con un ítem, vencido el 1/10/2026. */
async function plan(s: Seeded): Promise<string> {
  const row = await raw.treatmentPlan.create({
    data: {
      tenantId: s.tenantId,
      patientId: s.patientId,
      currency: 'USD',
      quoteIssuedOn: DAY('2026-09-01'),
      quoteValidUntil: DAY('2026-10-01'),
    },
  });
  await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: row.id,
      toothNumber: '11',
      catalogItemId: s.catalogItemId,
      price: 100,
    },
  });
  return row.id;
}

/** Una recotización de la firma (source ACCEPT) del plan. */
async function repricing(s: Seeded, planId: string): Promise<string> {
  const row = await raw.treatmentPlanRepricing.create({
    data: {
      tenantId: s.tenantId,
      planId,
      patientId: s.patientId,
      locationId: s.locationId,
      actorUserId: s.userId,
      source: 'ACCEPT',
      previewHash: HASH,
      currency: 'USD',
      previousQuoteIssuedOn: DAY('2026-09-01'),
      previousQuoteValidUntil: DAY('2026-10-01'),
      validityRenewed: true,
      quoteIssuedOn: DAY('2026-11-09'),
      quoteValidUntil: DAY('2026-12-09'),
      lines: [{ itemId: 'x' }],
      skipped: [],
      totalBefore: 100,
      totalAfter: 120,
    },
  });
  return row.id;
}

function acceptance(
  s: Seeded,
  planId: string,
  extra: Partial<Prisma.TreatmentPlanAcceptanceUncheckedCreateInput>,
): Prisma.TreatmentPlanAcceptanceUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    planId,
    patientId: s.patientId,
    locationId: s.locationId,
    signerName: 'Ana',
    signature: PNG,
    content: { version: 4 },
    contentHash: HASH,
    acceptanceHash: HASH,
    acceptedAt: new Date(),
    acceptedById: s.userId,
    ...extra,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const where = { tenantId: { in: seeds.map((s) => s.tenantId) } };
  // Sin `app.current_tenant` (owner): los triggers de solo alta dejan borrar.
  await raw.treatmentPlanAcceptance.deleteMany({ where });
  await raw.treatmentPlanRepricing.deleteMany({ where });
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

describe('treatment_plan_acceptances: aceptación de un presupuesto vencido (DX-379 C, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('dx379c-int-a');
    b = await seedClinic('dx379c-int-b');
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const insertAsA = (
    data: Prisma.TreatmentPlanAcceptanceUncheckedCreateInput,
  ) =>
    prisma.runWithTenant(a.tenantId, (tx) =>
      tx.treatmentPlanAcceptance.create({ data }),
    );

  it('sin modo y sin nada más (no vencido) se guarda, con o sin la copia de la validez', async () => {
    await expect(
      insertAsA(acceptance(a, await plan(a), {})),
    ).resolves.toMatchObject({ expiredMode: null, quoteValidUntil: null });
    await expect(
      insertAsA(
        acceptance(a, await plan(a), { quoteValidUntil: DAY('2026-12-09') }),
      ),
    ).resolves.toMatchObject({ expiredMode: null });
  });

  it('ORIGINAL_PRICES con motivo y la validez copiada se guarda; nota opcional salvo con OTHER', async () => {
    const saved = await insertAsA(
      acceptance(a, await plan(a), {
        quoteValidUntil: DAY('2026-10-01'),
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'LOYALTY',
      }),
    );
    expect(saved).toMatchObject({
      expiredMode: 'ORIGINAL_PRICES',
      expiredReason: 'LOYALTY',
      expiredNote: null,
      repricingId: null,
    });
    await expect(
      insertAsA(
        acceptance(a, await plan(a), {
          quoteValidUntil: DAY('2026-10-01'),
          expiredMode: 'ORIGINAL_PRICES',
          expiredReason: 'OTHER',
          expiredNote: 'Se respetó el precio pactado',
        }),
      ),
    ).resolves.toMatchObject({ expiredReason: 'OTHER' });
  });

  it.each<
    [string, Partial<Prisma.TreatmentPlanAcceptanceUncheckedCreateInput>]
  >([
    [
      'ORIGINAL_PRICES sin motivo',
      { quoteValidUntil: DAY('2026-10-01'), expiredMode: 'ORIGINAL_PRICES' },
    ],
    [
      'un modo sin la validez copiada',
      { expiredMode: 'ORIGINAL_PRICES', expiredReason: 'LOYALTY' },
    ],
    [
      'OTHER sin nota',
      {
        quoteValidUntil: DAY('2026-10-01'),
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'OTHER',
      },
    ],
    [
      'una nota con espacios alrededor',
      {
        quoteValidUntil: DAY('2026-10-01'),
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'OTHER',
        expiredNote: ' nota ',
      },
    ],
    [
      'una nota de más de 200',
      {
        quoteValidUntil: DAY('2026-10-01'),
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'LOYALTY',
        expiredNote: 'x'.repeat(201),
      },
    ],
    [
      'REPRICE sin recotización',
      { quoteValidUntil: DAY('2026-10-01'), expiredMode: 'REPRICE' },
    ],
    ['un motivo sin modo', { expiredReason: 'LOYALTY' }],
    ['una nota sin modo', { expiredNote: 'nota' }],
  ])('CHECK: rechaza %s', async (_label, extra) => {
    await expect(
      insertAsA(acceptance(a, await plan(a), extra)),
    ).rejects.toThrow(CHECK);
  });

  it('REPRICE con la recotización de su plan se guarda; con motivo, no', async () => {
    const planId = await plan(a);
    const repricingId = await repricing(a, planId);
    await expect(
      insertAsA(
        acceptance(a, planId, {
          quoteValidUntil: DAY('2026-10-01'),
          expiredMode: 'REPRICE',
          expiredReason: 'LOYALTY',
          repricingId,
        }),
      ),
    ).rejects.toThrow(CHECK);
    await expect(
      insertAsA(
        acceptance(a, planId, {
          quoteValidUntil: DAY('2026-10-01'),
          expiredMode: 'REPRICE',
          repricingId,
        }),
      ),
    ).resolves.toMatchObject({ expiredMode: 'REPRICE', repricingId });
  });

  it('FK compuesta: no admite la recotización de OTRO plan ni de otra clínica', async () => {
    const other = await plan(a);
    const otherRepricing = await repricing(a, other);
    await expect(
      insertAsA(
        acceptance(a, await plan(a), {
          quoteValidUntil: DAY('2026-10-01'),
          expiredMode: 'REPRICE',
          repricingId: otherRepricing,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    const foreign = await repricing(b, await plan(b));
    await expect(
      insertAsA(
        acceptance(a, await plan(a), {
          quoteValidUntil: DAY('2026-10-01'),
          expiredMode: 'REPRICE',
          repricingId: foreign,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('RLS e inmutabilidad: la otra clínica no ve las columnas; nadie las cambia', async () => {
    const planId = await plan(a);
    const saved = await insertAsA(
      acceptance(a, planId, {
        quoteValidUntil: DAY('2026-10-01'),
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'CLINIC_DELAY',
      }),
    );
    await expect(
      prisma.runWithTenant(b.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.findMany({ where: { id: saved.id } }),
      ),
    ).resolves.toEqual([]);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.update({
          where: { id: saved.id },
          data: { expiredReason: 'LOYALTY' },
        }),
      ),
    ).rejects.toThrow();
    const after = await raw.treatmentPlanAcceptance.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(after.expiredReason).toBe('CLINIC_DELAY');
  });
});
