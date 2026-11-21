import type { CommissionBasis, CommissionReleaseMode } from '@prisma/client';

/**
 * DX-018: regla de honorarios de un profesional. Base (lo cobrado o lo
 * producido), cuándo se libera (por prestación o con el plan completo y
 * pagado), % general y % por categoría del catálogo.
 *
 * DX-018-bis: la regla puede descontar antes del % el costo de laboratorio del
 * ítem (el de sus órdenes de laboratorio, DX-017) y la comisión de la pasarela
 * del abono (el % del medio de pago; no los ajustes al paciente de DX-516).
 */
export interface CommissionCategoryPercent {
  category: string;
  percent: number;
}

export interface CommissionRuleTerms {
  basis: CommissionBasis;
  releaseMode: CommissionReleaseMode;
  percent: number;
  categories: CommissionCategoryPercent[];
  /** Descontar el costo de laboratorio del ítem antes del %. */
  deductLabCost: boolean;
  /** Descontar la comisión de la pasarela del abono antes del %. */
  deductCardFee: boolean;
}

/** Qué descuentos se pueden activar (DX-018-bis: los dos tienen datos de origen). */
export const COMMISSION_DEDUCTIONS_AVAILABLE = {
  labCost: true,
  cardFee: true,
} as const;

export const COMMISSION_RULE_CATEGORIES_MAX = 50;
export const COMMISSION_CATEGORY_MAX_LENGTH = 120;

export const COMMISSION_RULE_MESSAGES = {
  percent:
    'El porcentaje tiene que ser un número de 0 a 100 con hasta 2 decimales.',
  categoryName: `La categoría tiene que tener entre 1 y ${COMMISSION_CATEGORY_MAX_LENGTH} caracteres.`,
  categoryDuplicated: 'Hay una categoría repetida en la regla.',
  categoriesMax: `Como mucho ${COMMISSION_RULE_CATEGORIES_MAX} categorías con porcentaje propio.`,
} as const;

/** 0–100 con hasta 2 decimales (la columna es DECIMAL(5,2)). */
export function isValidPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100 &&
    // Hasta 2 decimales: como lo escribe JavaScript («12.5», «35», «0.25»).
    /^\d{1,3}(\.\d{1,2})?$/.test(String(value))
  );
}

/** Clave de comparación de una categoría: recortada y sin mayúsculas. */
export function categoryKey(category: string): string {
  return category.trim().toLocaleLowerCase('es');
}

export type ParsedRuleTerms =
  { ok: true; terms: CommissionRuleTerms } | { ok: false; message: string };

export interface RuleTermsInput {
  basis: CommissionBasis;
  releaseMode: CommissionReleaseMode;
  percent: number;
  categories?: { category: string; percent: number }[];
  deductLabCost?: boolean;
  deductCardFee?: boolean;
}

/** Valida la regla que llega de la API (400 en español si algo no vale). */
export function parseRuleTerms(input: RuleTermsInput): ParsedRuleTerms {
  if (!isValidPercent(input.percent)) {
    return { ok: false, message: COMMISSION_RULE_MESSAGES.percent };
  }
  const raw = input.categories ?? [];
  if (raw.length > COMMISSION_RULE_CATEGORIES_MAX) {
    return { ok: false, message: COMMISSION_RULE_MESSAGES.categoriesMax };
  }
  const seen = new Set<string>();
  const categories: CommissionCategoryPercent[] = [];
  for (const entry of raw) {
    const category =
      typeof entry.category === 'string' ? entry.category.trim() : '';
    if (
      category.length === 0 ||
      [...category].length > COMMISSION_CATEGORY_MAX_LENGTH
    ) {
      return { ok: false, message: COMMISSION_RULE_MESSAGES.categoryName };
    }
    if (!isValidPercent(entry.percent)) {
      return { ok: false, message: COMMISSION_RULE_MESSAGES.percent };
    }
    const key = categoryKey(category);
    if (seen.has(key)) {
      return {
        ok: false,
        message: COMMISSION_RULE_MESSAGES.categoryDuplicated,
      };
    }
    seen.add(key);
    categories.push({ category, percent: entry.percent });
  }
  return {
    ok: true,
    terms: {
      basis: input.basis,
      releaseMode: input.releaseMode,
      percent: input.percent,
      categories,
      deductLabCost: input.deductLabCost === true,
      deductCardFee: input.deductCardFee === true,
    },
  };
}

/** El % que se aplica a un ítem: el de su categoría si la regla lo tiene; si no, el general. */
export function percentFor(
  terms: Pick<CommissionRuleTerms, 'percent' | 'categories'>,
  category: string | null,
): number {
  if (category !== null) {
    const key = categoryKey(category);
    const match = terms.categories.find((c) => categoryKey(c.category) === key);
    if (match) return match.percent;
  }
  return terms.percent;
}
