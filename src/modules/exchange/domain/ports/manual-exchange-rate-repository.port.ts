import type { ManualRateRow } from '../manual-rate-fallback';
import type { ManualExchangeRate } from '../entities/manual-exchange-rate.entity';

export const MANUAL_EXCHANGE_RATE_REPOSITORY = Symbol(
  'MANUAL_EXCHANGE_RATE_REPOSITORY',
);

export interface NewManualExchangeRate {
  date: string;
  currency: string;
  rate: number;
  /** DX-586: desde qué instante del día `date` rige. */
  effectiveFrom: Date;
  createdById: string;
}

/**
 * DX-586: la tasa manual que rige para una moneda en un instante: la de
 * mayor `effectiveFrom` ≤ ese instante del día pedido.
 */
export interface ManualRateInForce {
  id: string;
  rate: number;
  effectiveFrom: Date;
}

/** Ya hay una tasa para esa moneda desde ese instante en la clínica (índice único). */
export class ManualExchangeRateTakenError extends Error {
  constructor() {
    super('manual exchange rate already registered');
    this.name = 'ManualExchangeRateTakenError';
  }
}

/** Quien registra no es miembro vivo de la clínica (p. ej. break-glass). */
export class ManualExchangeRateAuthorError extends Error {
  constructor() {
    super('author is not a live member of the clinic');
    this.name = 'ManualExchangeRateAuthorError';
  }
}

/** DX-375: no hay esa tasa en la clínica del contexto. */
export class ManualExchangeRateNotFoundError extends Error {
  constructor() {
    super('manual exchange rate not found');
    this.name = 'ManualExchangeRateNotFoundError';
  }
}

/** DX-375: algún abono congeló la tasa; no se cambia. */
export class ManualExchangeRateInUseError extends Error {
  constructor() {
    super('manual exchange rate already used by a payment');
    this.name = 'ManualExchangeRateInUseError';
  }
}

/**
 * Tasas manuales de la clínica del contexto (`manual_exchange_rates`, RLS
 * FORCE): toda lectura y escritura va con `runWithTenant`.
 */
export interface ManualExchangeRateRepository {
  /**
   * Las tasas de un día civil que rigen en el instante `asOf` (DX-586: por
   * moneda, la de mayor `effectiveFrom` ≤ `asOf`), `{ moneda: tasa }` (vacío
   * si no hay).
   */
  ratesOn(date: string, asOf: Date): Promise<Record<string, ManualRateInForce>>;
  /**
   * DX-384: las tasas de los días `from`..`to` (ambos incluidos, días
   * civiles), de `currencies` si se dan; con ellas se elige la última tasa
   * dentro del plazo de la clínica. DX-586: solo las de `effectiveFrom` ≤
   * `asOf` y, por día y moneda, la última. Sin orden.
   */
  ratesBetween(
    from: string,
    to: string,
    currencies: readonly string[] | undefined,
    asOf: Date,
  ): Promise<ManualRateRow[]>;
  /**
   * Las últimas, del día más reciente al más antiguo; dentro del día, por
   * moneda y (DX-586) de la más reciente a la más antigua.
   */
  listRecent(limit: number): Promise<ManualExchangeRate[]>;
  /** DX-586: todas las tasas registradas para un día, por moneda y hora. */
  listDay(date: string): Promise<ManualExchangeRate[]>;
  /**
   * Alta. Lanza `ManualExchangeRateTakenError` si ya hay una para esa moneda
   * desde ese mismo instante (DX-586) y `ManualExchangeRateAuthorError` si el
   * autor no es miembro vivo.
   */
  create(input: NewManualExchangeRate): Promise<ManualExchangeRate>;
  /**
   * DX-375: cambia la tasa (solo `rate`; el día, la hora y la moneda no).
   * Bloquea la fila FOR UPDATE y comprueba en la misma transacción que ningún
   * abono la congeló (el alta de un abono la toma FOR SHARE; DX-586: un abono
   * la usa si la nombra en su referencia, o si no tiene referencia y es del
   * mismo día y moneda). Lanza
   * `ManualExchangeRateNotFoundError` o `ManualExchangeRateInUseError`.
   */
  correct(id: string, rate: number): Promise<ManualExchangeRate>;
  /** ¿Es `code` una moneda de `currencies`? */
  isKnownCurrency(code: string): Promise<boolean>;
  /**
   * Zona IANA de la sede de referencia (G1, R6): la sede activa del
   * contexto o, sin ella, la principal. Con ella se decide qué día es «hoy».
   */
  referenceTimeZone(): Promise<string>;
}
