import {
  DiscountReason,
  Prisma,
  PrismaClient,
  TreatmentPlanStatus,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-204, capa DB: las columnas del descuento (motivo, nota, autor, hora y
// sede) quedan congeladas por los triggers ampliados en un plan firmado
// (DX-012) o cerrado (DX-109); FK compuesta de la sede del descuento, CHECK del
// motivo, RLS FORCE de `discount_policies` e índice del informe. Cada caso
// escribe POR LA MISMA RUTA que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'b'.repeat(64);

interface Seeded {
  tenantId: string;
  userId: string;
  otherUserId: string;
  locationId: string;
  otherLocationId: string;
  patientId: string;
  catalogItemId: string;
  payerId: string;
  agreementId: string;
  otherAgreementId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const [user, other] = await Promise.all(
    ['a', 'b'].map((suffix) =>
      raw.user.create({
        data: {
          email: `${subdomain}-${suffix}@example.com`,
          passwordHash: 'x',
          fullName: `Dra ${subdomain} ${suffix}`,
        },
      }),
    ),
  );
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede principal' },
  });
  const otherLocation = await raw.location.create({
    data: { tenantId, name: 'Sede norte' },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
    },
  });
  // DX-105: dos convenios para probar la foto del precio.
  const payer = await raw.payer.create({
    data: { tenantId, name: 'Sanitas', type: 'EPS_CO', country: 'CO' },
  });
  const [agreement, otherAgreement] = await Promise.all(
    ['Convenio 10', 'Convenio 20'].map((name, i) =>
      raw.agreement.create({
        data: {
          tenantId,
          name,
          payerId: payer.id,
          kind: 'PERCENT_DISCOUNT',
          percent: (i + 1) * 10,
        },
      }),
    ),
  );
  return {
    payerId: payer.id,
    agreementId: agreement.id,
    otherAgreementId: otherAgreement.id,
    tenantId,
    userId: user.id,
    otherUserId: other.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
  };
}

/** Plan con un ítem descontado (con motivo, autor, hora y sede). */
async function seedDiscountedPlan(
  s: Seeded,
  status: TreatmentPlanStatus,
  itemStatus: 'PROPOSED' | 'ACCEPTED' = 'ACCEPTED',
): Promise<{ planId: string; itemId: string }> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'COP' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '11',
      catalogItemId: s.catalogItemId,
      price: 100000,
      discount: 15000,
      discountReason: DiscountReason.OTHER,
      discountReasonNote: 'Acuerdo con la aseguradora',
      discountById: s.userId,
      discountAt: new Date('2026-10-01T15:00:00Z'),
      discountLocationId: s.locationId,
      // DX-105: foto del precio (convenio del 10 % sobre el precio de catálogo).
      basePrice: 111000,
      priceSource: 'AGREEMENT_PERCENT',
      agreementId: s.agreementId,
      agreementName: 'Convenio 10',
      pricingLocationId: s.locationId,
      status: itemStatus,
    },
  });
  // El estado va después de los ítems: un plan cerrado no admite ítems nuevos.
  if (status !== TreatmentPlanStatus.DRAFT) {
    await raw.treatmentPlan.update({
      where: { id: plan.id },
      data: { status },
    });
  }
  return { planId: plan.id, itemId: item.id };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const where = { tenantId: { in: seeds.map((s) => s.tenantId) } };
  // Sin `app.current_tenant` (conexión owner): los triggers dejan borrar.
  await raw.toothRecord.deleteMany({ where });
  await raw.treatmentPlanAcceptance.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.discountPolicy.deleteMany({ where });
  await raw.agreement.deleteMany({ where });
  await raw.payer.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({
    where: { id: { in: seeds.map((s) => s.tenantId) } },
  });
  await raw.user.deleteMany({
    where: {
      id: { in: seeds.flatMap((s) => [s.userId, s.otherUserId]) },
    },
  });
}

const FK_VIOLATION = { code: 'P2003' };
const SIGNED = /23001|aceptado y firmado/;
const CLOSED = /23001|cerrado/;
const CHECK = /23514|check constraint/;
const RLS = /row-level security|42501/;

describe('DX-204 · columnas del descuento en la BD: triggers, FK, CHECK y RLS (int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('dx204-int-a');
    b = await seedClinic('dx204-int-b');
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  // Cambio de una sola columna del descuento, con un valor válido y distinto.
  const discountChanges = (): [
    string,
    Prisma.TreatmentPlanItemUncheckedUpdateInput,
  ][] => [
    ['discountReason', { discountReason: DiscountReason.PROMOTION }],
    ['discountReasonNote', { discountReasonNote: 'Otra nota' }],
    ['discountById', { discountById: a.otherUserId }],
    ['discountAt', { discountAt: new Date('2026-10-02T15:00:00Z') }],
    ['discountLocationId', { discountLocationId: a.otherLocationId }],
    // SEC-041: la referencia de la rebaja de precio también queda congelada.
    ['catalogPrice', { catalogPrice: 120000 }],
    // DX-105: la foto del precio (convenio / lista / catálogo) también.
    ['basePrice', { basePrice: 120000 }],
    ['priceSource', { priceSource: 'CATALOG' }],
    ['agreementId', { agreementId: a.otherAgreementId }],
    ['agreementName', { agreementName: 'Otro nombre' }],
    ['pricingLocationId', { pricingLocationId: a.otherLocationId }],
  ];

  describe('plan aceptado y firmado (DX-012)', () => {
    let itemId: string;

    beforeAll(async () => {
      const seeded = await seedDiscountedPlan(a, TreatmentPlanStatus.ACCEPTED);
      itemId = seeded.itemId;
      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.create({
          data: {
            tenantId: a.tenantId,
            planId: seeded.planId,
            patientId: a.patientId,
            locationId: a.locationId,
            signerName: 'Ana',
            signature: PNG,
            content: { version: 1 },
            contentHash: HASH,
            acceptanceHash: HASH,
            acceptedAt: new Date(),
            acceptedById: a.userId,
          },
        }),
      );
    });

    it.each([
      'discountReason',
      'discountReasonNote',
      'discountById',
      'discountAt',
      'discountLocationId',
      'basePrice',
      'priceSource',
      'agreementId',
      'agreementName',
      'pricingLocationId',
    ])('no admite cambiar %s', async (column) => {
      const [, data] = discountChanges().find(([c]) => c === column)!;
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({ where: { id: itemId }, data }),
        ),
      ).rejects.toThrow(SIGNED);
    });

    it('la foto del precio sigue como se firmó (DX-105)', async () => {
      const after = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(after).toMatchObject({
        basePrice: new Prisma.Decimal(111000),
        priceSource: 'AGREEMENT_PERCENT',
        agreementId: a.agreementId,
        agreementName: 'Convenio 10',
        pricingLocationId: a.locationId,
      });
    });

    it('no admite quitar el convenio (todo a NULL) en un plan firmado (DX-105)', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: itemId },
            data: {
              basePrice: null,
              priceSource: null,
              agreementId: null,
              agreementName: null,
              pricingLocationId: null,
            },
          }),
        ),
      ).rejects.toThrow(SIGNED);
    });

    it('el descuento sigue como se firmó', async () => {
      const after = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(after).toMatchObject({
        discountReason: DiscountReason.OTHER,
        discountReasonNote: 'Acuerdo con la aseguradora',
        discountById: a.userId,
        discountLocationId: a.locationId,
      });
    });

    it('no admite quitar el descuento con su autor (todo a NULL)', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: itemId },
            data: {
              discount: 0,
              discountReason: null,
              discountReasonNote: null,
              discountById: null,
              discountAt: null,
              discountLocationId: null,
            },
          }),
        ),
      ).rejects.toThrow(SIGNED);
    });

    it('sí admite avanzar el tratamiento (ACCEPTED → DONE) sin tocar el descuento', async () => {
      const done = await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemId },
          data: { status: 'DONE' },
        }),
      );
      expect(done.status).toBe('DONE');
      expect(done.discountReason).toBe(DiscountReason.OTHER);
    });
  });

  describe('plan cerrado (DX-109)', () => {
    // REJECTED usa la misma rama del trigger (y exige motivo y fecha en su CHECK).
    it.each([TreatmentPlanStatus.CANCELLED])(
      'un plan %s no admite cambiar las columnas del descuento',
      async (status) => {
        const { itemId } = await seedDiscountedPlan(a, status, 'PROPOSED');
        for (const [, data] of discountChanges()) {
          await expect(
            asA((tx) =>
              tx.treatmentPlanItem.update({ where: { id: itemId }, data }),
            ),
          ).rejects.toThrow(CLOSED);
        }
      },
    );

    it('completado: ACCEPTED → DONE pasa, pero no con un cambio del descuento a la vez', async () => {
      const { itemId } = await seedDiscountedPlan(
        a,
        TreatmentPlanStatus.COMPLETED,
      );
      for (const [, data] of discountChanges()) {
        await expect(
          asA((tx) =>
            tx.treatmentPlanItem.update({
              where: { id: itemId },
              data: { ...data, status: 'DONE' },
            }),
          ),
        ).rejects.toThrow(CLOSED);
      }
      const done = await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemId },
          data: { status: 'DONE' },
        }),
      );
      expect(done.status).toBe('DONE');
    });

    it('un plan abierto sigue admitiendo cambiar la foto del precio (DX-105)', async () => {
      const { itemId } = await seedDiscountedPlan(
        a,
        TreatmentPlanStatus.DRAFT,
        'PROPOSED',
      );
      const updated = await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemId },
          data: {
            priceSource: 'CATALOG',
            agreementId: null,
            agreementName: null,
          },
        }),
      );
      expect(updated).toMatchObject({
        priceSource: 'CATALOG',
        agreementId: null,
        agreementName: null,
      });
    });

    it('un plan abierto sigue admitiendo cambiar el descuento y su motivo', async () => {
      const { itemId } = await seedDiscountedPlan(
        a,
        TreatmentPlanStatus.DRAFT,
        'PROPOSED',
      );
      const updated = await asA((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemId },
          data: {
            discount: 5000,
            discountReason: DiscountReason.LOYALTY,
            discountReasonNote: null,
            discountLocationId: a.otherLocationId,
          },
        }),
      );
      expect(updated).toMatchObject({
        discountReason: DiscountReason.LOYALTY,
        discountLocationId: a.otherLocationId,
      });
    });
  });

  describe('FK compuesta y CHECK del motivo', () => {
    let itemId: string;

    beforeAll(async () => {
      ({ itemId } = await seedDiscountedPlan(
        a,
        TreatmentPlanStatus.DRAFT,
        'PROPOSED',
      ));
    });

    it('el convenio del ítem no puede ser de otra clínica (DX-105)', async () => {
      const foreign = await raw.agreement.create({
        data: {
          tenantId: b.tenantId,
          name: 'Convenio B',
          payerId: b.payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        },
      });
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: itemId },
            data: { agreementId: foreign.id },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('la sede del precio no puede ser de otra clínica (DX-105)', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: itemId },
            data: { pricingLocationId: b.locationId },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('la sede del descuento no puede ser de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: itemId },
            data: { discountLocationId: b.locationId },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it.each([
      ['nota sin motivo', { discountReason: null, discountReasonNote: 'x' }],
      [
        '«Otro» sin nota',
        { discountReason: 'OTHER', discountReasonNote: null },
      ],
      ['nota en blanco', { discountReasonNote: '   ' }],
      ['nota de más de 200', { discountReasonNote: 'x'.repeat(201) }],
      ['un precio de catálogo negativo (SEC-041)', { catalogPrice: -1 }],
      ['un precio base negativo (DX-105)', { basePrice: -1 }],
    ] as const)('CHECK: rechaza %s', async (_label, data) => {
      await expect(
        asA((tx) =>
          tx.treatmentPlanItem.update({ where: { id: itemId }, data }),
        ),
      ).rejects.toThrow(CHECK);
    });
  });

  describe('discount_policies: RLS FORCE y CHECK', () => {
    beforeAll(async () => {
      await asA((tx) =>
        tx.discountPolicy.create({
          data: { tenantId: a.tenantId, dentistMaxPercent: 20 },
        }),
      );
    });

    it('la otra clínica no ve la política ni la escribe con el tenant de A', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.discountPolicy.findMany(),
      );
      expect(seen).toEqual([]);
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.discountPolicy.updateMany({
            where: { tenantId: a.tenantId },
            data: { dentistMaxPercent: 100 },
          }),
        ),
      ).resolves.toEqual({ count: 0 });
      await expect(
        prisma.runWithTenant(
          b.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO "discount_policies" ("tenantId", "updatedAt") VALUES (${a.tenantId}::uuid, now())`,
        ),
      ).rejects.toThrow(RLS);
      const own = await asA((tx) => tx.discountPolicy.findMany());
      expect(own).toHaveLength(1);
      expect(own[0].dentistMaxPercent).toBe(20);
    });

    it.each([
      ['un tope de más de 100', { adminMaxPercent: 101 }],
      ['un tope negativo', { dentistMaxPercent: -1 }],
      ['un umbral de más de 100', { reasonRequiredAbovePercent: 101 }],
    ])('CHECK: rechaza %s', async (_label, data) => {
      await expect(
        asA((tx) =>
          tx.discountPolicy.update({ where: { tenantId: a.tenantId }, data }),
        ),
      ).rejects.toThrow(CHECK);
    });

    it('tiene RLS forzado', async () => {
      const [row] = await raw.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'discount_policies'`;
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  it('el informe tiene su índice parcial por fecha del descuento, con las rebajas de precio (SEC-041)', async () => {
    const indexes = await raw.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'treatment_plan_items'
         AND indexname LIKE 'treatment_plan_items_tenant_%discount%at_idx'`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      'treatment_plan_items_tenant_effective_discount_at_idx',
    ]);
    expect(indexes[0].indexdef).toMatch(
      /COALESCE\("discountAt", "createdAt"\).*WHERE \(\(\(discount > \(0\)::numeric\) OR \(price < "catalogPrice"\)\) AND \("deletedAt" IS NULL\)\)/,
    );
  });
});
