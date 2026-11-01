import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { budgetStillMatches } from '../src/modules/signature-requests/application/remote-budget';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import {
  composeQuoteContent,
  quoteIssuedOn,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  computeQuoteHash,
  parseQuoteContent,
} from '../src/modules/treatment-plans/domain/plan-quote';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-502 contra Postgres: la moneda del catálogo queda congelada en el ítem
// ("catalogCurrency"). El relleno de la migración pone la común de las sedes
// activas (o nada si no hay una común), también en ítems de planes firmados o
// cerrados, sin tocar ningún importe; una vez escrita no cambia; y un plan en
// EUR con el catálogo en COP se envía y se firma con el precio de lista en
// COP y sin «ahorro» entre monedas, que sigue en COP aunque luego cambien las
// sedes.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const signatures = new PrismaSignatureRequestRepository(prisma, tenantContext);

const BACKFILL = '20261111180100_dx502_plan_item_catalog_currency_backfill';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** psql no acepta el `?schema=public` de las URL de Prisma. */
function runBackfill(): void {
  const url = new URL(process.env.DIRECT_URL as string);
  url.search = '';
  const file = join(
    __dirname,
    '..',
    'prisma/migrations',
    BACKFILL,
    'migration.sql',
  );
  execFileSync(
    'psql',
    [url.toString(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file],
    { stdio: 'pipe' },
  );
}

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
  catalogItemId: string;
}

async function seedClinic(
  subdomain: string,
  sedes: { currency: string | null; isActive?: boolean }[],
): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const locations = [];
  for (const [n, sede] of sedes.entries()) {
    const location = await owner.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: tenant.id,
        name: `Sede ${n + 1} ${subdomain}`,
        currency: sede.currency,
        isActive: sede.isActive ?? true,
      }),
    });
    locations.push(location);
  }
  const user = await owner.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const patient = await owner.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: subdomain,
      email: `ana@${subdomain}.test`,
    },
  });
  const catalog = await owner.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
      defaultPrice: 80000,
    },
  });
  return {
    tenantId: tenant.id,
    locationId: locations[0].id,
    patientId: patient.id,
    userId: user.id,
    catalogItemId: catalog.id,
  };
}

async function planWithItem(
  c: Clinic,
  plan: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
  item: Partial<Prisma.TreatmentPlanItemUncheckedCreateInput> = {},
): Promise<{ planId: string; itemId: string }> {
  const created = await owner.treatmentPlan.create({
    data: {
      tenantId: c.tenantId,
      patientId: c.patientId,
      currency: 'EUR',
      status: 'PRESENTED',
      presentedAt: new Date(),
      presentedLocationId: c.locationId,
      ...plan,
    },
  });
  const row = await owner.treatmentPlanItem.create({
    data: {
      tenantId: c.tenantId,
      planId: created.id,
      toothNumber: '36',
      catalogItemId: c.catalogItemId,
      price: 100.55,
      catalogPrice: 100.55,
      basePrice: 80000,
      priceSource: 'PRICE_LIST',
      ...item,
    },
  });
  return { planId: created.id, itemId: row.id };
}

const asClinic = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantContext.run(tenantId, fn);

/** Envía el presupuesto como la app (foto v3 + hash) y lo firma el paciente. */
async function sendAndSign(c: Clinic, planId: string): Promise<void> {
  const budget = await asClinic(c.tenantId, () =>
    signatures.loadBudget(c.patientId, planId, c.locationId),
  );
  if (!budget) throw new Error('sin presupuesto');
  const content = composeQuoteContent(
    budget.quote,
    quoteIssuedOn(budget.quote, new Date()),
    {},
  );
  const now = new Date();
  const { id } = await asClinic(c.tenantId, () =>
    signatures.create({
      locationId: c.locationId,
      patientId: c.patientId,
      type: 'BUDGET',
      channel: 'EMAIL',
      templateId: null,
      templateVersion: null,
      treatmentPlanId: planId,
      title: 'Presupuesto de tratamiento',
      body: 'Condiciones',
      budgetContent: content,
      budgetContentHash: computeQuoteHash(content),
      professionalUserId: c.userId,
      professionalName: 'Dra.',
      signerType: 'PATIENT',
      signerName: 'Ana Int',
      signerDocument: null,
      destination: 'ana@example.com',
      destinationMasked: 'an***@example.com',
      tokenHash: hashSignatureToken(generateSignatureToken()),
      expiresAt: new Date(now.getTime() + 72 * 3600_000),
      createdById: c.userId,
      createdAt: now,
    }),
  );
  await asClinic(c.tenantId, () =>
    signatures.withLockedRequest(
      id,
      { ipAddress: '203.0.113.7', userAgent: 'int', requestId: null },
      (r) => ({
        write: {
          patch: { openedAt: now, verifiedAt: now, signedAt: now },
          audit: [{ action: 'SIGN', reason: 'SIGNATURE_PATIENT_SIGNED' }],
          budget: {
            planId,
            locationId: r.locationId,
            stillMatches: (quote) => budgetStillMatches(r, quote, {}),
            signerName: r.signerName,
            signature: PNG,
            content: r.budgetContent as object,
            contentHash: r.budgetContentHash!,
            acceptanceHash: 'c'.repeat(64),
            acceptedAt: now,
            acceptedById: r.createdById,
            ipAddress: '203.0.113.7',
            userAgent: 'int',
            remoteChannel: 'EMAIL',
            remoteDestinationMasked: r.destinationMasked,
            remoteSentAt: r.createdAt,
            remoteOpenedAt: now,
            remoteVerifiedAt: now,
          },
        },
        result: 'SIGNED' as const,
      }),
    ),
  );
}

async function catalogCurrencyOf(itemId: string): Promise<string | null> {
  const row = await owner.treatmentPlanItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { catalogCurrency: true },
  });
  return row.catalogCurrency;
}

describe('moneda del catálogo en el ítem del plan (DX-502, Postgres)', () => {
  beforeAll(async () => {
    await resetDatabase(owner);
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  describe('relleno de la migración', () => {
    let common: Clinic;
    let mixed: Clinic;
    let unconfigured: Clinic;
    const items: Record<string, string> = {};
    let amountsBefore: unknown;

    beforeAll(async () => {
      // Dos sedes activas en COP y una inactiva en EUR: la común es COP.
      common = await seedClinic('dx502-comun', [
        { currency: 'COP' },
        { currency: 'COP' },
        { currency: 'EUR', isActive: false },
      ]);
      mixed = await seedClinic('dx502-mixta', [
        { currency: 'COP' },
        { currency: 'EUR' },
      ]);
      unconfigured = await seedClinic('dx502-sin-moneda', [
        { currency: 'COP' },
        { currency: null },
      ]);
      items.open = (await planWithItem(common)).itemId;
      items.free = (
        await planWithItem(common, {}, { basePrice: null, catalogPrice: null })
      ).itemId;
      items.retired = (
        await planWithItem(common, {}, { deletedAt: new Date() })
      ).itemId;
      items.closed = (
        await planWithItem(common, { status: 'COMPLETED' }, { status: 'DONE' })
      ).itemId;
      const signed = await planWithItem(common);
      items.signed = signed.itemId;
      await sendAndSign(common, signed.planId);
      items.mixed = (await planWithItem(mixed)).itemId;
      items.unconfigured = (await planWithItem(unconfigured)).itemId;
      // Las filas sembradas por `owner` nacen sin moneda, como las anteriores
      // a la migración.
      expect(
        await owner.treatmentPlanItem.count({
          where: { catalogCurrency: { not: null } },
        }),
      ).toBe(0);
      amountsBefore = await owner.treatmentPlanItem.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          price: true,
          discount: true,
          catalogPrice: true,
          basePrice: true,
          updatedAt: true,
        },
      });
      runBackfill();
    });

    it('pone la moneda común de las sedes activas, también en ítems retirados, firmados y cerrados', async () => {
      for (const key of ['open', 'retired', 'closed', 'signed']) {
        expect(await catalogCurrencyOf(items[key])).toBe('COP');
      }
    });

    it('sin precio de catálogo, sin moneda común o con una sede sin moneda: NULL', async () => {
      expect(await catalogCurrencyOf(items.free)).toBeNull();
      expect(await catalogCurrencyOf(items.mixed)).toBeNull();
      expect(await catalogCurrencyOf(items.unconfigured)).toBeNull();
    });

    it('no cambia ningún importe (ni la hora de modificación) y es idempotente', async () => {
      runBackfill();
      const after = await owner.treatmentPlanItem.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          price: true,
          discount: true,
          catalogPrice: true,
          basePrice: true,
          updatedAt: true,
        },
      });
      expect(after).toEqual(amountsBefore);
      expect(await catalogCurrencyOf(items.open)).toBe('COP');
    });
  });

  it('una vez escrita, la moneda del catálogo no cambia ni se borra (trigger)', async () => {
    const c = await seedClinic('dx502-congelada', [{ currency: 'COP' }]);
    const { itemId } = await planWithItem(c, {}, { catalogCurrency: 'COP' });
    for (const value of ['USD', null]) {
      await expect(
        asClinic(c.tenantId, () =>
          prisma.runWithTenant((tx) =>
            tx.treatmentPlanItem.update({
              where: { id: itemId },
              data: { catalogCurrency: value },
            }),
          ),
        ),
      ).rejects.toThrow(/moneda del catálogo del ítem queda fijada/);
    }
    expect(await catalogCurrencyOf(itemId)).toBe('COP');
  });

  it('plan en EUR con el catálogo en COP: se firma con el precio de lista en COP, sin ahorro, y sigue en COP aunque cambien las sedes', async () => {
    const c = await seedClinic('dx502-eur-cop', [{ currency: 'COP' }]);
    // Precio de convenio en EUR (la foto del nombre basta: el «ahorro» es
    // lo que se comprueba) sobre un catálogo en COP.
    const { planId } = await planWithItem(
      c,
      {},
      { catalogCurrency: 'COP', agreementName: 'Lista Euro' },
    );
    await sendAndSign(c, planId);

    // Las sedes pasan a USD después de firmar.
    await owner.location.updateMany({
      where: { tenantId: c.tenantId },
      data: { ...locationData(REGIONAL_NEW_YORK_FIXTURE, {}) },
    });

    const acceptance = await owner.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    const signed = parseQuoteContent(acceptance.content);
    expect(signed.version).toBe(3);
    expect(signed.currency).toBe('EUR');
    expect(signed.items[0]).toMatchObject({
      unitPrice: 100.55,
      listPrice: 80000,
      listPriceCurrency: 'COP',
    });
    expect(signed.totals[0]).toMatchObject({
      currency: 'EUR',
      net: 100.55,
      agreementSaving: 0,
    });
    expect(computeQuoteHash(signed)).toBe(acceptance.contentHash);
    // El ítem vivo tampoco se mueve con las sedes.
    const live = await asClinic(c.tenantId, () =>
      signatures.loadBudget(c.patientId, planId, c.locationId),
    );
    expect(live?.quote.items[0].listPriceCurrency).toBe('COP');
  });
});
