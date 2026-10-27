export const PLAN_CURRENCY_SOURCE = Symbol('PLAN_CURRENCY_SOURCE');

/**
 * De dónde sale la moneda de un plan sin `currency` explícita (GLOBAL-G1,
 * R14): la sede activa del request o, sin ella, las sedes activas de la clínica.
 * `currency: null` / `unconfigured` = sede sin moneda (nunca se sustituye).
 */
export type PlanCurrencyContext =
  | { kind: 'location'; locationId: string; currency: string | null }
  | {
      kind: 'clinic';
      /** Monedas distintas de las sedes activas con moneda. */
      currencies: string[];
      /** Hay alguna sede activa sin moneda. */
      unconfigured: boolean;
    };

export interface PlanCurrencySource {
  context(): Promise<PlanCurrencyContext>;
}
