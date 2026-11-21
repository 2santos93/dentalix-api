import { addCivilDays, parseCivilDate } from '../../../shared/time/civil-day';
import { toRateColumn } from '../../../shared/money/rate-conversion';

/**
 * DX-585: la tasa oficial del Banco Central de Venezuela (fuente `BCV`). El
 * BCV publica cada día hábil los bolívares por 1 USD y por 1 EUR con una
 * «Fecha Valor» (normalmente el siguiente día hábil): desde ese día rige.
 */
export interface BcvRate {
  /** Bolívares por 1 USD (hasta 8 decimales, como los publica el BCV). */
  usdVes: number;
  /** Bolívares por 1 EUR. */
  eurVes: number;
  /** «Fecha Valor» (AAAA-MM-DD): el primer día en que rige esta tasa. */
  valueDate: string;
  /** Cuándo se consultó. */
  fetchedAt: Date;
}

/** De dónde salió: la página oficial del BCV o el respaldo. */
export type BcvRateOrigin = 'BCV' | 'FALLBACK';

export interface BcvRateSnapshot extends BcvRate {
  origin: BcvRateOrigin;
}

/** Monedas cuya tasa sale del BCV con la fuente `BCV`; el resto, del proveedor. */
export const BCV_CURRENCIES: readonly string[] = ['VES', 'EUR'];

/** Zona de Caracas (UTC−4, sin horario de verano): la de la «Fecha Valor». */
export const BCV_TIME_ZONE = 'America/Caracas';

/**
 * Antigüedad máxima (días de calendario) de la última fecha valor que vale
 * para un día: cubre fines de semana y los feriados más largos (Carnaval,
 * Semana Santa, Navidad). Más vieja que eso, la moneda queda «sin tasa»:
 * nunca se arrastra una tasa de semanas si la consulta dejó de funcionar.
 */
export const BCV_MAX_AGE_DAYS = 7;

/** Primer día (fecha valor) que vale para la tasa del día `date`. */
export function bcvOldestValueDate(date: string): string {
  return addCivilDays(date, -BCV_MAX_AGE_DAYS);
}

/**
 * Validación de cordura (D2): EUR por USD (`usdVes / eurVes`) entre estos
 * dos topes. El euro ha valido entre 0,8 y 1,6 USD: con ±50 % alrededor de 1
 * se atrapa un valor cruzado o un número mal leído (p. ej. sin decimales).
 */
export const BCV_EUR_PER_USD_MIN = 0.5;
export const BCV_EUR_PER_USD_MAX = 1.5;

/** Variación máxima (fracción) frente a la última tasa guardada. */
export const BCV_MAX_VARIATION = 0.3;

/**
 * Un número en formato es («1.011,17949056», «918,76620000»): punto de miles
 * y coma decimal. `null` si no lo es (vacío, letras, varias comas, miles mal
 * agrupados). Solo lee el texto: no redondea.
 */
export function parseEsDecimal(text: string): number | null {
  const value = text.replace(/\s+/g, '');
  if (
    !/^\d{1,3}(?:\.\d{3})*(?:,\d+)?$/.test(value) &&
    !/^\d+(?:,\d+)?$/.test(value)
  ) {
    return null;
  }
  const parsed = Number(value.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Por qué una tasa no es creíble, o `null` si lo es: tasas > 0 y finitas,
 * fecha valor real, EUR/USD razonable y, si hay una anterior guardada,
 * variación < 30 % en las dos monedas.
 */
export function bcvSanityProblem(
  next: Pick<BcvRate, 'usdVes' | 'eurVes' | 'valueDate'>,
  previous: Pick<BcvRate, 'usdVes' | 'eurVes'> | null,
): string | null {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  if (!positive(next.usdVes) || !positive(next.eurVes)) {
    return 'tasa no positiva';
  }
  if (parseCivilDate(next.valueDate) === null) return 'fecha valor inválida';
  const eurPerUsd = next.usdVes / next.eurVes;
  if (eurPerUsd < BCV_EUR_PER_USD_MIN || eurPerUsd > BCV_EUR_PER_USD_MAX) {
    return 'EUR/USD fuera de rango';
  }
  if (previous) {
    const jump = (now: number, before: number) =>
      Math.abs(now / before - 1) >= BCV_MAX_VARIATION;
    if (
      jump(next.usdVes, previous.usdVes) ||
      jump(next.eurVes, previous.eurVes)
    ) {
      return 'variación >= 30 % frente a la última guardada';
    }
  }
  return null;
}

/**
 * Las tasas del BCV en la forma de todas las tasas de Dentalix: unidades de
 * cada moneda por 1 USD. VES = bolívares por USD; EUR = bolívares por USD ÷
 * bolívares por EUR, con los 8 decimales de la columna de tasas.
 */
export function bcvRatesPerUsd(
  rate: Pick<BcvRate, 'usdVes' | 'eurVes'>,
): Record<string, number> {
  return {
    VES: rate.usdVes,
    EUR: toRateColumn(rate.usdVes / rate.eurVes),
  };
}
