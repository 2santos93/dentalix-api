import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCatalogPriceChangeRepository } from '../src/modules/dental-catalog/infrastructure/repositories/prisma-catalog-price-change.repository';
import {
  canonicalCriteria,
  planPriceChange,
  priceChangeRequestFingerprint,
  type PriceChangeCriteria,
} from '../src/modules/dental-catalog/domain/price-change';
import { resetDatabase } from './support/e2e-fixtures';

// DX-205, capa DB: el lote de «Actualizar precios» se aplica por conjuntos en
// UNA transacción (500 ítems en < 2 s), es atómico, no toca otra clínica y
// el historial es de solo alta.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaCatalogPriceChangeRepository(prisma, tenantContext);

const CATEGORY = 'Prevención';
const ITEMS = 500;

const criteria: PriceChangeCriteria = {
  filters: { category: CATEGORY, activeOnly: true },
  mode: 'PERCENT',
  value: new Prisma.Decimal(5),
  roundTo: 100,
  minIncrement: null,
};

let tenantA: string;
let tenantB: string;
let userId: string;

const asTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantContext.run(tenantId, fn);

async function seedCatalog(tenantId: string, prefix: string, count: number) {
  await owner.dentalCatalogItem.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      tenantId,
      code: `${prefix}-${String(i).padStart(4, '0')}`,
      category: CATEGORY,
      kind: 'PROCEDURE' as const,
      labelEs: `Profilaxis ${i}`,
      color: '#0E7490',
      // VES: de 1.000 a 50.900 en saltos de 100, con céntimos sueltos.
      defaultPrice: new Prisma.Decimal(1000 + i * 100).plus('0.40'),
    })),
  });
}

async function pricesOf(tenantId: string): Promise<Map<string, string>> {
  const rows = await owner.dentalCatalogItem.findMany({
    where: { tenantId },
    select: { id: true, defaultPrice: true },
  });
  return new Map(rows.map((r) => [r.id, r.defaultPrice?.toFixed(2) ?? '']));
}

describe('DX-205 · lote de precios del catálogo (int)', () => {
  beforeAll(async () => {
    await resetDatabase(owner);
    tenantA = (
      await owner.tenant.create({
        data: { name: 'dx205-int-a', subdomain: 'dx205-int-a' },
      })
    ).id;
    tenantB = (
      await owner.tenant.create({
        data: { name: 'dx205-int-b', subdomain: 'dx205-int-b' },
      })
    ).id;
    userId = (
      await owner.user.create({
        data: {
          email: 'dx205@example.test',
          fullName: 'Dra. Precios',
          passwordHash: 'x',
        },
        select: { id: true },
      })
    ).id;
    await seedCatalog(tenantA, 'A', ITEMS);
    await seedCatalog(tenantB, 'B', 20);
  }, 60_000);

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('un fallo a mitad no deja nada: ni lote, ni precios, ni historial', async () => {
    const before = await pricesOf(tenantA);
    const key = randomUUID();
    await expect(
      asTenant(tenantA, () =>
        repo.apply(
          { key, fingerprint: 'a'.repeat(64) },
          userId,
          canonicalCriteria(criteria),
          (items) => {
            const plan = planPriceChange(items, criteria, 'VES');
            // Un ítem que no existe: el UPDATE por conjuntos cambia una fila
            // menos de las esperadas y la transacción entera se deshace.
            const ghost = { ...plan.lines[0].item, id: randomUUID() };
            return {
              ...plan,
              lines: [...plan.lines, { ...plan.lines[0], item: ghost }],
            };
          },
        ),
      ),
    ).rejects.toThrow(/filas actualizadas/);
    expect(await pricesOf(tenantA)).toEqual(before);
    expect(
      await owner.catalogPriceBatch.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
    expect(
      await owner.catalogPriceHistory.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
  });

  it('aplica 500 ítems en menos de 2 s, en una transacción, sin tocar otra clínica', async () => {
    const pricesB = await pricesOf(tenantB);
    const items = await asTenant(tenantA, () => repo.candidates());
    // RLS: solo los de A.
    expect(items).toHaveLength(ITEMS);
    const preview = planPriceChange(items, criteria, 'VES');
    expect(preview.lines).toHaveLength(ITEMS);

    const key = randomUUID();
    const started = performance.now();
    const outcome = await asTenant(tenantA, () =>
      repo.apply(
        {
          key,
          fingerprint: priceChangeRequestFingerprint(
            criteria,
            preview.previewHash,
          ),
        },
        userId,
        canonicalCriteria(criteria),
        (locked) => {
          const plan = planPriceChange(locked, criteria, 'VES');
          expect(plan.previewHash).toBe(preview.previewHash);
          return plan;
        },
      ),
    );
    const elapsed = performance.now() - started;
    expect(outcome.kind).toBe('applied');
    expect(elapsed).toBeLessThan(2000);

    // Los precios escritos son exactamente los de la vista previa.
    const after = await pricesOf(tenantA);
    for (const line of preview.lines) {
      expect(after.get(line.item.id)).toBe(line.after.toFixed(2));
    }
    // 1.000,40 × 1,05 = 1.050,42 → 1.100 (a 100 VES).
    const first = preview.lines.find((l) => l.item.code === 'A-0000');
    expect(first?.after.toFixed(2)).toBe('1100.00');

    const batch = await owner.catalogPriceBatch.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    expect(batch).toMatchObject({ itemCount: ITEMS, currency: 'VES' });
    expect(batch.totalAfter.toFixed(2)).toBe(preview.totals.after.toFixed(2));
    const history = await owner.catalogPriceHistory.findMany({
      where: { tenantId: tenantA },
    });
    expect(history).toHaveLength(ITEMS);
    expect(
      history.every((h) => h.batchId === batch.id && h.actorUserId === userId),
    ).toBe(true);

    // La otra clínica, intacta.
    expect(await pricesOf(tenantB)).toEqual(pricesB);
    expect(
      await owner.catalogPriceHistory.count({ where: { tenantId: tenantB } }),
    ).toBe(0);
  }, 30_000);

  it('la misma clave no aplica el lote dos veces', async () => {
    const batch = await owner.catalogPriceBatch.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    const pricesBefore = await pricesOf(tenantA);
    const replay = await asTenant(tenantA, () =>
      repo.apply(
        {
          key: batch.idempotencyKey,
          fingerprint: batch.requestFingerprint,
        },
        userId,
        canonicalCriteria(criteria),
        () => {
          throw new Error('no debe recalcular una repetición');
        },
      ),
    );
    expect(replay).toMatchObject({ kind: 'replayed', batch: { id: batch.id } });
    const reused = await asTenant(tenantA, () =>
      repo.findApplied({
        key: batch.idempotencyKey,
        fingerprint: 'b'.repeat(64),
      }),
    );
    expect(reused).toEqual({ kind: 'key-reused' });
    expect(await pricesOf(tenantA)).toEqual(pricesBefore);
    expect(
      await owner.catalogPriceHistory.count({ where: { tenantId: tenantA } }),
    ).toBe(ITEMS);
  });

  it('el historial y los lotes son de solo alta para la app', async () => {
    for (const table of ['catalog_price_history', 'catalog_price_batches']) {
      await expect(
        asTenant(tenantA, () =>
          prisma.runWithTenant((tx) =>
            tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "createdAt" = "createdAt"`,
            ),
          ),
        ),
      ).rejects.toThrow(/permission denied|solo alta/);
      await expect(
        asTenant(tenantA, () =>
          prisma.runWithTenant((tx) =>
            tx.$executeRawUnsafe(`DELETE FROM "${table}"`),
          ),
        ),
      ).rejects.toThrow(/permission denied|solo alta/);
    }
  });

  it('el historial no apunta a un ítem de otra clínica (FK compuesta)', async () => {
    const itemB = await owner.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId: tenantB },
      select: { id: true },
    });
    await expect(
      owner.catalogPriceHistory.create({
        data: {
          tenantId: tenantA,
          catalogItemId: itemB.id,
          actorUserId: userId,
          previousPrice: 1,
          newPrice: 2,
        },
      }),
    ).rejects.toThrow(/catalog_price_history_item_fkey|Foreign key/);
  });

  it('la clínica B no ve el historial de A (RLS)', async () => {
    const itemA = await owner.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId: tenantA },
      select: { id: true },
    });
    expect(
      await asTenant(tenantB, () => repo.history(itemA.id, 10)),
    ).toBeNull();
    const own = await asTenant(tenantA, () => repo.history(itemA.id, 10));
    expect(own).toHaveLength(1);
    expect(own?.[0]).toMatchObject({ actorName: 'Dra. Precios' });
  });
});
