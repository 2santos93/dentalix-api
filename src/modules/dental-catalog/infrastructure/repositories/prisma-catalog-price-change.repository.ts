import { Injectable } from '@nestjs/common';
import { CatalogKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PriceChangeCandidate } from '../../domain/price-change';
import type {
  AppliedPriceBatch,
  ApplyPriceChangeOutcome,
  CatalogPriceChangeRepository,
  CatalogPriceHistoryEntry,
  DecidePriceChange,
  PriceChangeIdempotency,
} from '../../domain/ports/catalog-price-change-repository.port';
import type { CanonicalPriceChangeCriteria } from '../../domain/price-change';

interface CandidateRow {
  id: string;
  code: string;
  labelEs: string;
  category: string | null;
  kind: CatalogKind;
  active: boolean;
  defaultPrice: Prisma.Decimal | null;
}

type BatchRow = Prisma.CatalogPriceBatchGetPayload<object>;

function toCandidate(row: CandidateRow): PriceChangeCandidate {
  return {
    id: row.id,
    code: row.code,
    labelEs: row.labelEs,
    category: row.category,
    kind: row.kind,
    active: row.active,
    defaultPrice:
      row.defaultPrice === null ? null : new Prisma.Decimal(row.defaultPrice),
  };
}

function toBatch(row: BatchRow): AppliedPriceBatch {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    currency: row.currency,
    itemCount: row.itemCount,
    totalBefore: row.totalBefore,
    totalAfter: row.totalAfter,
    createdAt: row.createdAt,
  };
}

/** La fila de una clave ya usada: la misma petición o otra. */
function replayOf(
  previous: BatchRow | null,
  idempotency: PriceChangeIdempotency,
): Exclude<ApplyPriceChangeOutcome, { kind: 'applied' }> | null {
  if (!previous) return null;
  return previous.requestFingerprint === idempotency.fingerprint
    ? { kind: 'replayed', batch: toBatch(previous) }
    : { kind: 'key-reused' };
}

const CANDIDATE_SELECT = {
  id: true,
  code: true,
  labelEs: true,
  category: true,
  kind: true,
  active: true,
  defaultPrice: true,
} as const satisfies Prisma.DentalCatalogItemSelect;

/**
 * DX-205: «Actualizar precios» del catálogo en bloque y el historial de
 * precios. Todo bajo `runWithTenant` (RLS FORCE): ningún precio de otra
 * clínica se lee ni se toca.
 */
@Injectable()
export class PrismaCatalogPriceChangeRepository implements CatalogPriceChangeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async candidates(): Promise<PriceChangeCandidate[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.dentalCatalogItem.findMany({
        where: { tenantId, deletedAt: null },
        select: CANDIDATE_SELECT,
      }),
    );
    return rows.map(toCandidate);
  }

  findApplied(
    idempotency: PriceChangeIdempotency,
  ): Promise<Exclude<ApplyPriceChangeOutcome, { kind: 'applied' }> | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) =>
      replayOf(
        await tx.catalogPriceBatch.findFirst({
          where: { tenantId, idempotencyKey: idempotency.key },
        }),
        idempotency,
      ),
    );
  }

  async apply(
    idempotency: PriceChangeIdempotency,
    actorUserId: string,
    criteria: CanonicalPriceChangeCriteria,
    decide: DecidePriceChange,
  ): Promise<ApplyPriceChangeOutcome> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La segunda petición con la misma clave (doble clic, reintento) espera
      // aquí a la primera y, si ya aplicó, devuelve lo aplicado.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext('dx_catalog_price_batch_idempotency:' || ${tenantId}),
        hashtext(${idempotency.key})
      )`;
      const replay = replayOf(
        await tx.catalogPriceBatch.findFirst({
          where: { tenantId, idempotencyKey: idempotency.key },
        }),
        idempotency,
      );
      if (replay) return replay;

      // El catálogo vivo de la clínica, bloqueado: una edición suelta o otro
      // lote a la vez espera, y el cálculo ve los precios que se escriben.
      const rows = await tx.$queryRaw<CandidateRow[]>`
        SELECT "id", "code", "labelEs", "category", "kind", "active", "defaultPrice"
          FROM "dental_catalog_items"
         WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL
         ORDER BY "id"
           FOR UPDATE`;
      const plan = decide(rows.map(toCandidate));

      const batch = await tx.catalogPriceBatch.create({
        data: {
          tenantId,
          actorUserId,
          idempotencyKey: idempotency.key,
          requestFingerprint: idempotency.fingerprint,
          previewHash: plan.previewHash,
          currency: plan.currency,
          criteria: criteria,
          itemCount: plan.lines.length,
          totalBefore: plan.totals.before,
          totalAfter: plan.totals.after,
        },
      });

      // Por conjuntos: UN UPDATE … FROM unnest para todo el lote (no fila a
      // fila). Los precios viajan como texto y se convierten a numeric en la
      // base: el Decimal nunca pasa por un `number`.
      const ids = plan.lines.map((line) => line.item.id);
      const prices = plan.lines.map((line) => line.after.toFixed(2));
      const updated = await tx.$executeRaw`
        UPDATE "dental_catalog_items" AS c
           SET "defaultPrice" = v.price,
               "updatedAt" = timezone('UTC'::text, now())
          FROM unnest(${ids}::uuid[], ${prices}::numeric[]) AS v(id, price)
         WHERE c."id" = v.id AND c."tenantId" = ${tenantId}::uuid`;
      if (updated !== plan.lines.length) {
        // Imposible con el catálogo bloqueado; si pasa, nada se queda a medias.
        throw new Error(
          `catalog price batch: ${updated} filas actualizadas de ${plan.lines.length}`,
        );
      }

      await tx.catalogPriceHistory.createMany({
        data: plan.lines.map((line) => ({
          tenantId,
          catalogItemId: line.item.id,
          batchId: batch.id,
          actorUserId,
          previousPrice: line.before,
          newPrice: line.after,
          createdAt: batch.createdAt,
        })),
      });

      return { kind: 'applied', batch: toBatch(batch) };
    });
  }

  async history(
    catalogItemId: string,
    limit: number,
  ): Promise<CatalogPriceHistoryEntry[] | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const item = await tx.dentalCatalogItem.findFirst({
        where: { id: catalogItemId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!item) return null;
      const rows = await tx.catalogPriceHistory.findMany({
        where: { tenantId, catalogItemId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: { actor: { select: { fullName: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        previousPrice: row.previousPrice,
        newPrice: row.newPrice,
        batchId: row.batchId,
        actorUserId: row.actorUserId,
        actorName: row.actor.fullName,
        createdAt: row.createdAt,
      }));
    });
  }
}
