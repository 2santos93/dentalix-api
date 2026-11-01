export interface Currency {
  code: string;
  name: string;
  symbol: string;
  /** DX-340: minor units de ISO 4217 (SIX List One). */
  minorUnits: number;
  /** DX-340: decimales del redondeo por línea (total = suma de líneas). */
  roundingDigits: number;
}
