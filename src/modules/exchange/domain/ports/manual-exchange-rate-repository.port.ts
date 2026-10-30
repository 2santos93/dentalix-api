import type { ManualExchangeRate } from '../entities/manual-exchange-rate.entity';

export const MANUAL_EXCHANGE_RATE_REPOSITORY = Symbol(
  'MANUAL_EXCHANGE_RATE_REPOSITORY',
);

export interface NewManualExchangeRate {
  date: string;
  currency: string;
  rate: number;
  createdById: string;
}

/** Ya hay una tasa para ese día y moneda en la clínica (índice único). */
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

/**
 * Tasas manuales de la clínica del contexto (`manual_exchange_rates`, RLS
 * FORCE): toda lectura y escritura va con `runWithTenant`.
 */
export interface ManualExchangeRateRepository {
  /** Las tasas de un día civil, `{ moneda: tasa }` (vacío si no hay). */
  ratesOn(date: string): Promise<Record<string, number>>;
  /** Las últimas, del día más reciente al más antiguo y por moneda. */
  listRecent(limit: number): Promise<ManualExchangeRate[]>;
  /**
   * Alta. Lanza `ManualExchangeRateTakenError` si ya hay una para ese día y
   * moneda y `ManualExchangeRateAuthorError` si el autor no es miembro vivo.
   */
  create(input: NewManualExchangeRate): Promise<ManualExchangeRate>;
  /** ¿Es `code` una moneda de `currencies`? */
  isKnownCurrency(code: string): Promise<boolean>;
  /**
   * Zona IANA de la sede de referencia (G1, R6): la sede activa del
   * contexto o, sin ella, la principal. Con ella se decide qué día es «hoy».
   */
  referenceTimeZone(): Promise<string>;
}
