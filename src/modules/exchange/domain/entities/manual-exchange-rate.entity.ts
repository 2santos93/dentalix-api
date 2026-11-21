/**
 * DX-374: tasa de cambio que una clínica fijó para un día civil y una moneda
 * (DX-586: desde una hora de ese día).
 * Como `ExchangeRateSnapshot`, `rate` son unidades de `currency` por 1 USD y
 * va como `number` (Prisma devuelve `Decimal`).
 */
export interface ManualExchangeRate {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** ISO 4217, nunca USD. */
  currency: string;
  rate: number;
  /**
   * DX-586: desde qué instante del día `date` rige. Varias el mismo día:
   * cada abono usa la de mayor `effectiveFrom` ≤ su instante.
   */
  effectiveFrom: Date;
  createdBy: {
    userId: string;
    /** `null` si el usuario ya no es resoluble. */
    fullName: string | null;
  };
  createdAt: Date;
  /**
   * DX-375: algún abono vivo o anulado congeló esta tasa (como moneda del
   * abono o de destino): ya no se puede cambiar.
   */
  inUse: boolean;
}
