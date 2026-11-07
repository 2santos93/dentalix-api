import type { RoundingDigits } from '../../../../shared/money/line-rounding';
import type { FrozenReferenceRate } from '../../../discounts/domain/reference-in-plan';

export const REFERENCE_RATE_SOURCE = Symbol('REFERENCE_RATE_SOURCE');

/**
 * DX-513-bis: la tasa para congelar la referencia de un ítem, o «sin tasa».
 * Con tasa trae también los dígitos de redondeo de la moneda de destino (la
 * del plan): la conversión se redondea UNA vez a ellos.
 */
export type ReferenceRateLookup =
  | { kind: 'rate'; rate: FrozenReferenceRate; toDigits: RoundingDigits }
  | {
      kind: 'missing';
      /** La moneda sin tasa (la que falta registrar o la que no da el proveedor). */
      currency: string;
      /** Día civil para el que se pidió (null si no llegó a pedirse). */
      date: string | null;
    };

/**
 * DX-513-bis §5.3: la tasa de la clínica (DX-374: proveedor o manual) de
 * `from` a `to` para HOY en la sede de escritura del request (la misma que
 * sella el descuento, DX-204). Solo lee. «Sin tasa» no lanza: lo devuelve,
 * para que el caso de uso responda 422 (nunca 500); cualquier otro fallo se
 * propaga.
 */
export interface ReferenceRateSource {
  rateFor(from: string, to: string): Promise<ReferenceRateLookup>;
}

/**
 * Sin fuente de tasas configurada (specs que no la necesitan): «sin tasa»,
 * cerrado por defecto. El módulo registra la real.
 */
export const NO_REFERENCE_RATES: ReferenceRateSource = {
  rateFor: (from) =>
    Promise.resolve({ kind: 'missing', currency: from, date: null }),
};
