import type { Prisma } from '@prisma/client';
import type {
  CanonicalPriceChangeCriteria,
  PriceChangeCandidate,
  PriceChangePlan,
} from '../price-change';

/** La Idempotency-Key de `/apply` (en minúsculas) y la huella de la petición. */
export interface PriceChangeIdempotency {
  key: string;
  fingerprint: string;
}

/** Un lote aplicado, tal como se guardó. */
export interface AppliedPriceBatch {
  id: string;
  actorUserId: string;
  currency: string | null;
  itemCount: number;
  totalBefore: Prisma.Decimal;
  totalAfter: Prisma.Decimal;
  createdAt: Date;
}

export type ApplyPriceChangeOutcome =
  | { kind: 'applied'; batch: AppliedPriceBatch }
  /** La misma petición con la misma clave: el lote de entonces. */
  | { kind: 'replayed'; batch: AppliedPriceBatch }
  /** La misma clave con otra petición. */
  | { kind: 'key-reused' };

/**
 * Lo que decide el lote con el catálogo ya bloqueado: el caso de uso
 * recalcula con `planPriceChange` (la función de la vista previa) y lanza si
 * la huella no coincide o no hay nada que aplicar.
 */
export type DecidePriceChange = (
  items: PriceChangeCandidate[],
) => PriceChangePlan;

export interface CatalogPriceHistoryEntry {
  id: string;
  previousPrice: Prisma.Decimal | null;
  newPrice: Prisma.Decimal | null;
  batchId: string | null;
  actorUserId: string;
  actorName: string;
  createdAt: Date;
}

export const CATALOG_PRICE_CHANGE_REPOSITORY = Symbol(
  'CATALOG_PRICE_CHANGE_REPOSITORY',
);

export interface CatalogPriceChangeRepository {
  /** Los ítems vivos de la clínica (bajo RLS), sin filtrar: filtra el dominio. */
  candidates(): Promise<PriceChangeCandidate[]>;

  /** Un lote ya aplicado con esta clave, o null. */
  findApplied(
    idempotency: PriceChangeIdempotency,
  ): Promise<Exclude<ApplyPriceChangeOutcome, { kind: 'applied' }> | null>;

  /**
   * En UNA transacción: candado por clave, repetición, catálogo de la clínica
   * FOR UPDATE, `decide`, alta del lote, UPDATE por conjuntos de los precios e
   * historial de cada ítem.
   */
  apply(
    idempotency: PriceChangeIdempotency,
    actorUserId: string,
    criteria: CanonicalPriceChangeCriteria,
    decide: DecidePriceChange,
  ): Promise<ApplyPriceChangeOutcome>;

  /**
   * El historial de precios de un ítem, del más reciente al más antiguo
   * (como mucho `limit`). null si el ítem no existe en esta clínica.
   */
  history(
    catalogItemId: string,
    limit: number,
  ): Promise<CatalogPriceHistoryEntry[] | null>;
}
