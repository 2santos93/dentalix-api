import type { CommissionBasis, CommissionReleaseMode } from '@prisma/client';

/**
 * DX-018: regla de honorarios de un profesional. Base (lo cobrado o lo
 * producido), cuándo se libera (por prestación o con el plan completo y
 * pagado), % general y % por categoría del catálogo.
 *
 * El costo de laboratorio y la comisión de la pasarela NO se guardan: no hay
 * datos de origen (DX-017 no guarda el costo; los ajustes por medio de pago de
 * DX-516 son al paciente, no la comisión que cobra la pasarela a la clínica).
 * El cálculo los admite (`CommissionDeductions`), pero hoy siempre van
 * apagados: `COMMISSION_DEDUCTIONS_AVAILABLE`.
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
  /** Descontar el costo de laboratorio del ítem antes del %. Hoy, siempre false. */
  deductLabCost: boolean;
  /** Descontar la comisión de la pasarela del abono antes del %. Hoy, siempre false. */
  deductCardFee: boolean;
}

/** Qué descuentos se pueden activar hoy y por qué no (lo enseña la web). */
export const COMMISSION_DEDUCTIONS_AVAILABLE = {
  labCost: false,
  cardFee: false,
} as const;

export const COMMISSION_RULE_CATEGORIES_MAX = 50;
export const COMMISSION_CATEGORY_MAX_LENGTH = 120;

export const COMMISSION_RULE_MESSAGES = {
  percent:
    'El porcentaje tiene que ser un número de 0 a 100 con hasta 2 decimales.',
  categoryName: `La categoría tiene que tener entre 1 y ${COMMISSION_CATEGORY_MAX_LENGTH} caracteres.`,
  categoryDuplicated: 'Hay una categoría repetida en la regla.',
  categoriesMax: `Como mucho ${COMMISSION_RULE_CATEGORIES_MAX} categorías con porcentaje propio.`,
  labCostUnavailable:
    'Descontar el costo de laboratorio aún no está disponible: las órdenes de laboratorio no guardan su costo.',
  cardFeeUnavailable:
    'Descontar la comisión de la pasarela aún no está disponible: los medios de pago no guardan el porcentaje que cobra la pasarela.',
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
  if (
    input.deductLabCost === true &&
    !COMMISSION_DEDUCTIONS_AVAILABLE.labCost
  ) {
    return { ok: false, message: COMMISSION_RULE_MESSAGES.labCostUnavailable };
  }
  if (
    input.deductCardFee === true &&
    !COMMISSION_DEDUCTIONS_AVAILABLE.cardFee
  ) {
    return { ok: false, message: COMMISSION_RULE_MESSAGES.cardFeeUnavailable };
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
      deductLabCost: false,
      deductCardFee: false,
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
