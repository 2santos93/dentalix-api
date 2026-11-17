import { createHash } from 'node:crypto';
import { CatalogKind, Prisma } from '@prisma/client';

/**
 * DX-205: subir (o bajar) en bloque el precio por defecto del catálogo.
 *
 * Este módulo es el ÚNICO sitio que decide qué ítems entran y qué precio
 * nuevo tiene cada uno: la vista previa y la aplicación llaman a
 * `planPriceChange` con los mismos criterios y la aplicación exige la huella
 * (`previewHash`) que dio la vista previa. Todo el dinero va en Decimal; nunca
 * pasa por un `number` antes de escribirse.
 */

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

/** Tope de la columna `defaultPrice` (Decimal(12,2)), el mismo que MONEY_MAX. */
export const PRICE_CHANGE_MAX_PRICE = new Decimal('9999999999.99');
/** Ítems que cambia un lote como mucho (la prueba de rendimiento usa 500). */
export const PRICE_CHANGE_MAX_ITEMS = 2000;
/** Unidades de redondeo admitidas, en unidades de la moneda del catálogo. */
export const PRICE_CHANGE_ROUNDING_UNITS = [1, 10, 100, 1000] as const;
export type PriceChangeRoundingUnit =
  (typeof PRICE_CHANGE_ROUNDING_UNITS)[number];

export type PriceChangeMode = 'PERCENT' | 'AMOUNT';

export interface PriceChangeFilters {
  /** Categoría exacta (sin distinguir mayúsculas ni espacios de los bordes). */
  category?: string | null;
  kind?: CatalogKind | null;
  /** Solo ítems activos. */
  activeOnly?: boolean;
  /** «Solo si el precio es menor que X»: deja fuera los que no tienen precio. */
  priceBelow?: Decimal | null;
}

export interface PriceChangeCriteria {
  filters: PriceChangeFilters;
  mode: PriceChangeMode;
  /** % (PERCENT) o importe (AMOUNT), con signo; nunca 0. */
  value: Decimal;
  /** null = sin redondeo (2 decimales). */
  roundTo: PriceChangeRoundingUnit | null;
  /** Solo en subidas: lo mínimo que sube un precio. null = sin mínimo. */
  minIncrement: Decimal | null;
}

/** Lo que el cálculo necesita de un ítem del catálogo. */
export interface PriceChangeCandidate {
  id: string;
  code: string;
  labelEs: string;
  category: string | null;
  kind: CatalogKind;
  active: boolean;
  defaultPrice: Decimal | null;
}

export type PriceChangeSkipReason =
  /** Sin precio por defecto: no hay base sobre la que calcular. */
  | 'NO_PRICE'
  /** El precio nuevo es igual al de ahora (p. ej. el redondeo lo devuelve). */
  | 'UNCHANGED'
  /** El precio nuevo pasa del tope de la columna. */
  | 'OUT_OF_RANGE';

export interface PriceChangeLine {
  item: PriceChangeCandidate;
  before: Decimal;
  after: Decimal;
}

export interface PriceChangeSkip {
  item: PriceChangeCandidate;
  reason: PriceChangeSkipReason;
}

export interface PriceChangePlan {
  currency: string | null;
  lines: PriceChangeLine[];
  skipped: PriceChangeSkip[];
  totals: { before: Decimal; after: Decimal };
  /** SHA-256 (hex) de la moneda, los criterios y cada línea (id, antes, después). */
  previewHash: string;
}

export type PriceComputation =
  | { kind: 'priced'; after: Decimal }
  | { kind: 'skip'; reason: PriceChangeSkipReason };

const ZERO = new Decimal(0);

function normalizedCategory(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase('es') : null;
}

/** ¿El ítem entra en el lote según los filtros? (sin mirar el cálculo) */
export function matchesPriceChangeFilters(
  item: PriceChangeCandidate,
  filters: PriceChangeFilters,
): boolean {
  if (filters.kind && item.kind !== filters.kind) return false;
  if (filters.activeOnly && !item.active) return false;
  const category = normalizedCategory(filters.category);
  if (category !== null && normalizedCategory(item.category) !== category) {
    return false;
  }
  if (filters.priceBelow) {
    if (item.defaultPrice === null) return false;
    if (!item.defaultPrice.lessThan(filters.priceBelow)) return false;
  }
  return true;
}

/** Al múltiplo de `unit` más cercano (mitad hacia arriba); sin unidad, a céntimos. */
function roundPrice(value: Decimal, unit: number | null): Decimal {
  if (unit === null) return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return value
    .dividedBy(unit)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .times(unit);
}

/** Al múltiplo de `unit` igual o mayor; sin unidad, a céntimos hacia arriba. */
function ceilPrice(value: Decimal, unit: number | null): Decimal {
  if (unit === null) return value.toDecimalPlaces(2, Decimal.ROUND_UP);
  return value
    .dividedBy(unit)
    .toDecimalPlaces(0, Decimal.ROUND_CEIL)
    .times(unit);
}

/**
 * El precio nuevo de UN ítem:
 * 1. % (`antes × (1 + v/100)`) o importe fijo (`antes + v`);
 * 2. redondeo al múltiplo más cercano de la unidad (o a céntimos);
 * 3. el redondeo no invierte el sentido: en una subida nunca queda por debajo
 *    del precio de antes y en una bajada nunca por encima (queda igual);
 * 4. nunca por debajo de 0;
 * 5. en una subida, si sube menos que el incremento mínimo, sube
 *    `antes + mínimo` redondeado HACIA ARRIBA a la unidad.
 * Igual al de antes: UNCHANGED. Por encima del tope de la columna: OUT_OF_RANGE.
 */
export function computeNewPrice(
  before: Decimal | null,
  criteria: Pick<
    PriceChangeCriteria,
    'mode' | 'value' | 'roundTo' | 'minIncrement'
  >,
): PriceComputation {
  if (before === null) return { kind: 'skip', reason: 'NO_PRICE' };
  const raising = criteria.value.greaterThan(0);
  const raw =
    criteria.mode === 'PERCENT'
      ? before.times(criteria.value.dividedBy(100).plus(1))
      : before.plus(criteria.value);
  let after = roundPrice(raw, criteria.roundTo);
  if (raising && after.lessThan(before)) after = before;
  if (!raising && after.greaterThan(before)) after = before;
  if (after.lessThan(ZERO)) after = ZERO;
  if (
    raising &&
    criteria.minIncrement !== null &&
    after.minus(before).lessThan(criteria.minIncrement)
  ) {
    after = ceilPrice(before.plus(criteria.minIncrement), criteria.roundTo);
  }
  if (after.greaterThan(PRICE_CHANGE_MAX_PRICE)) {
    return { kind: 'skip', reason: 'OUT_OF_RANGE' };
  }
  if (after.equals(before)) return { kind: 'skip', reason: 'UNCHANGED' };
  return { kind: 'priced', after };
}

/** Los criterios en una forma canónica (la huella y la fila del lote). */
export function canonicalCriteria(criteria: PriceChangeCriteria) {
  return {
    filters: {
      category: criteria.filters.category?.trim() || null,
      kind: criteria.filters.kind ?? null,
      activeOnly: criteria.filters.activeOnly === true,
      priceBelow: criteria.filters.priceBelow?.toFixed(2) ?? null,
    },
    mode: criteria.mode,
    value: criteria.value.toFixed(2),
    roundTo: criteria.roundTo,
    minIncrement: criteria.minIncrement?.toFixed(2) ?? null,
  };
}

export type CanonicalPriceChangeCriteria = ReturnType<typeof canonicalCriteria>;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * El lote entero: los ítems que entran por los filtros, ordenados por código,
 * con su precio de antes y el nuevo, los omitidos y por qué, los totales y la
 * huella. La vista previa y la aplicación usan esta misma función.
 */
export function planPriceChange(
  items: readonly PriceChangeCandidate[],
  criteria: PriceChangeCriteria,
  currency: string | null,
): PriceChangePlan {
  const matched = items
    .filter((item) => matchesPriceChangeFilters(item, criteria.filters))
    .sort((a, b) =>
      a.code === b.code ? a.id.localeCompare(b.id) : a.code < b.code ? -1 : 1,
    );
  const lines: PriceChangeLine[] = [];
  const skipped: PriceChangeSkip[] = [];
  let totalBefore = ZERO;
  let totalAfter = ZERO;
  for (const item of matched) {
    const result = computeNewPrice(item.defaultPrice, criteria);
    if (result.kind === 'skip') {
      skipped.push({ item, reason: result.reason });
      continue;
    }
    // `computeNewPrice` solo da precio si había uno antes.
    const before = item.defaultPrice as Decimal;
    lines.push({ item, before, after: result.after });
    totalBefore = totalBefore.plus(before);
    totalAfter = totalAfter.plus(result.after);
  }
  const previewHash = sha256([
    'dx205-v1',
    currency,
    canonicalCriteria(criteria),
    lines.map((line) => [
      line.item.id.toLowerCase(),
      line.before.toFixed(2),
      line.after.toFixed(2),
    ]),
  ]);
  return {
    currency,
    lines,
    skipped,
    totals: { before: totalBefore, after: totalAfter },
    previewHash,
  };
}

/**
 * Huella de una petición de aplicar (la de la Idempotency-Key): los criterios
 * y la huella de la vista previa. La misma clave con otra huella: 422.
 */
export function priceChangeRequestFingerprint(
  criteria: PriceChangeCriteria,
  previewHash: string,
): string {
  return sha256([
    'dx205-apply-v1',
    canonicalCriteria(criteria),
    previewHash.toLowerCase(),
  ]);
}
