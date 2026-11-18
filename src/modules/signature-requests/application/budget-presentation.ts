import { planPresentationOf } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import type { QuoteContent } from '../../treatment-plans/domain/plan-quote';
import type { PlanQuoteSource } from '../../treatment-plans/domain/ports/plan-quote-repository.port';
import { civilDateIn } from '../../../shared/time/civil-day';

/**
 * DX-560: cómo se presenta al paciente el presupuesto de un enlace de
 * aceptación (DX-415), congelado al crear la solicitud (también las del
 * seguimiento DX-561) en `signature_requests.budgetPresentation`, FUERA de lo
 * sellado: la firma y su hash siguen cubriendo solo `budgetContent`. Sin ids
 * internos (la página es pública): cada ítem se refiere a su posición en la
 * foto enviada.
 */
export interface BudgetPresentation {
  /** Idioma del paciente o, sin él, `es`. */
  language: string;
  /** `index`: posición del ítem en `budgetContent.items`. */
  items: { index: number; visit: number; label: string }[];
  /** Una fila por visita, en orden: su etiqueta y los días tras la anterior. */
  visitOrganization: {
    visit: number;
    label: string | null;
    minDaysAfterPrevious: number;
  }[];
  /**
   * La segunda moneda de la sede, orientativa, con la tasa GUARDADA ese día
   * en la clínica (nunca el proveedor). Sin tasa guardada o sin segunda
   * moneda, no está.
   */
  secondCurrency?: BudgetSecondCurrency;
}

export interface BudgetSecondCurrency {
  currency: string;
  /** Unidades de la moneda del plan por 1 USD. */
  fromPerBase: number;
  /** Unidades de la segunda moneda por 1 USD. */
  toPerBase: number;
  /** De dónde salió la tasa (MANUAL o el proveedor, ya guardada). */
  source: string;
  /** Día civil de la tasa (`YYYY-MM-DD`). */
  date: string;
}

/** Las tasas guardadas de un día: la lectura `stored()` de DX-569. */
export interface StoredDayRates {
  source: string;
  /** Unidades de cada moneda por 1 USD (USD no viene: vale 1). */
  rates: Record<string, number>;
  rateDate: string;
}

/**
 * Puerto de la segunda moneda: cuál es la de la sede y las tasas que la
 * clínica YA tiene guardadas (nunca llama al proveedor de tasas).
 */
export interface BudgetSecondCurrencySource {
  /** La segunda moneda de la sede para un plan en `planCurrency`, o `null`. */
  currencyFor(input: {
    locationId: string;
    locationCurrency: string | null;
    planCurrency: string;
    now: Date;
    timeZone: string;
  }): Promise<string | null>;
  stored(
    date: string,
    currencies: readonly string[],
  ): Promise<StoredDayRates | null>;
}

export const BUDGET_SECOND_CURRENCY_SOURCE = Symbol(
  'BUDGET_SECOND_CURRENCY_SOURCE',
);

/** Sin fuente configurada (tests que no la usan): nunca hay segunda moneda. */
export const NO_SECOND_CURRENCY: BudgetSecondCurrencySource = {
  currencyFor: () => Promise.resolve(null),
  stored: () => Promise.resolve(null),
};

const BASE_CURRENCY = 'USD';

/** Unidades de `currency` por 1 USD, o `null` si no hay tasa válida. */
function perBase(read: StoredDayRates, currency: string): number | null {
  const value = currency === BASE_CURRENCY ? 1 : read.rates[currency];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Ítems y visitas de la presentación, en el orden de la foto enviada. */
export function budgetPresentationItems(
  quote: PlanQuoteSource,
  content: QuoteContent,
): Omit<BudgetPresentation, 'secondCurrency'> {
  const presentation = planPresentationOf(quote);
  const byItem = new Map(presentation.items.map((i) => [i.itemId, i]));
  const items = content.items.map((item, index) => {
    const shown = byItem.get(item.id);
    return {
      index,
      visit: shown?.visit ?? 1,
      label: shown?.label ?? item.procedure,
    };
  });
  const organization = new Map<
    number,
    { visit: number; label: string | null; minDaysAfterPrevious: number }
  >();
  for (const entry of quote.visitOrganization ?? []) {
    const known = organization.get(entry.visit);
    if (!known) {
      organization.set(entry.visit, {
        visit: entry.visit,
        label: entry.label,
        minDaysAfterPrevious: entry.minDaysAfterPrevious,
      });
    } else if (known.label === null && entry.label !== null) {
      known.label = entry.label;
    }
  }
  for (const item of items) {
    if (!organization.has(item.visit)) {
      organization.set(item.visit, {
        visit: item.visit,
        label: null,
        minDaysAfterPrevious: 0,
      });
    }
  }
  const visits = new Set(items.map((i) => i.visit));
  return {
    language: presentation.language,
    items,
    visitOrganization: [...organization.values()]
      .filter((v) => visits.has(v.visit))
      .sort((a, b) => a.visit - b.visit),
  };
}

/**
 * La presentación congelada de una solicitud nueva: ítems y visitas y, si la
 * sede tiene una segunda moneda con tasa guardada HOY en la zona de la sede
 * (o la del plazo de la tasa manual, DX-384), esa moneda y su tasa.
 */
export async function composeBudgetPresentation(
  quote: PlanQuoteSource,
  content: QuoteContent,
  source: BudgetSecondCurrencySource,
  now: Date,
): Promise<BudgetPresentation> {
  const base = budgetPresentationItems(quote, content);
  const planCurrency = content.currency;
  const second = await source.currencyFor({
    locationId: quote.location.id,
    locationCurrency: quote.location.currency ?? null,
    planCurrency,
    now,
    timeZone: quote.location.timeZone,
  });
  if (!second || second === planCurrency) return base;
  const today = civilDateIn(now, quote.location.timeZone);
  const read = await source.stored(today, [planCurrency, second]);
  if (!read) return base;
  const fromPerBase = perBase(read, planCurrency);
  const toPerBase = perBase(read, second);
  if (fromPerBase === null || toPerBase === null) return base;
  return {
    ...base,
    secondCurrency: {
      currency: second,
      fromPerBase,
      toPerBase,
      source: read.source,
      date: read.rateDate,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * La presentación guardada, validada al leerla (JSONB). `null` si no hay
 * (solicitudes anteriores a DX-560, CONSENT) o si no tiene la forma
 * esperada: la página pública cae entonces a la lista de siempre.
 */
export function parseBudgetPresentation(
  value: unknown,
  itemCount: number,
): BudgetPresentation | null {
  if (!isRecord(value)) return null;
  const { language, items, visitOrganization, secondCurrency } = value;
  if (typeof language !== 'string' || !Array.isArray(items)) return null;
  if (!Array.isArray(visitOrganization)) return null;
  const parsedItems: BudgetPresentation['items'] = [];
  for (const item of items) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.index) ||
      !Number.isInteger(item.visit) ||
      typeof item.label !== 'string'
    ) {
      return null;
    }
    parsedItems.push({
      index: item.index as number,
      visit: item.visit as number,
      label: item.label,
    });
  }
  // Un ítem por línea de la foto, en su orden: si no, no describe lo enviado.
  if (
    parsedItems.length !== itemCount ||
    parsedItems.some((i, position) => i.index !== position)
  ) {
    return null;
  }
  const parsedVisits: BudgetPresentation['visitOrganization'] = [];
  for (const visit of visitOrganization) {
    if (
      !isRecord(visit) ||
      !Number.isInteger(visit.visit) ||
      !(visit.label === null || typeof visit.label === 'string') ||
      !Number.isInteger(visit.minDaysAfterPrevious)
    ) {
      return null;
    }
    parsedVisits.push({
      visit: visit.visit as number,
      label: visit.label,
      minDaysAfterPrevious: visit.minDaysAfterPrevious as number,
    });
  }
  const out: BudgetPresentation = {
    language,
    items: parsedItems,
    visitOrganization: parsedVisits,
  };
  if (
    isRecord(secondCurrency) &&
    typeof secondCurrency.currency === 'string' &&
    typeof secondCurrency.fromPerBase === 'number' &&
    typeof secondCurrency.toPerBase === 'number' &&
    typeof secondCurrency.source === 'string' &&
    typeof secondCurrency.date === 'string'
  ) {
    out.secondCurrency = {
      currency: secondCurrency.currency,
      fromPerBase: secondCurrency.fromPerBase,
      toPerBase: secondCurrency.toPerBase,
      source: secondCurrency.source,
      date: secondCurrency.date,
    };
  }
  return out;
}
