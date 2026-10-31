import { RoundingDigits, roundingDigits } from './line-rounding';

/**
 * Decimales de una moneda tal como los guarda `currencies` (DX-340), la ÚNICA
 * fuente en runtime: ningún módulo tiene su lista de monedas sin decimales.
 */
export interface CurrencyDigits {
  /** Minor units de ISO 4217 (SIX List One): `currencies.minor_units`. */
  minorUnits: number;
  /** Decimales del redondeo por línea: `currencies.rounding_digits`. */
  roundingDigits: RoundingDigits;
}

/** Tabla de decimales por código ISO (en mayúsculas). */
export class CurrencyDigitsTable {
  private readonly byCode: ReadonlyMap<string, CurrencyDigits>;

  constructor(
    rows: readonly {
      code: string;
      minorUnits: number;
      roundingDigits: number;
    }[],
  ) {
    this.byCode = new Map(
      rows.map((row) => [
        row.code.toUpperCase(),
        {
          minorUnits: row.minorUnits,
          roundingDigits: roundingDigits(row.roundingDigits),
        },
      ]),
    );
  }

  has(code: string): boolean {
    return this.byCode.has(code.toUpperCase());
  }

  /** Decimales de `code`; una moneda fuera del catálogo es un error. */
  of(code: string): CurrencyDigits {
    const digits = this.byCode.get(code.toUpperCase());
    if (!digits)
      throw new Error(`Moneda sin decimales en el catálogo: ${code}`);
    return digits;
  }

  roundingDigits(code: string): RoundingDigits {
    return this.of(code).roundingDigits;
  }
}

export const CURRENCY_DIGITS_CATALOG = Symbol('CURRENCY_DIGITS_CATALOG');

/** Lector de los decimales de `currencies` (tabla global, sin tenant). */
export interface CurrencyDigitsCatalog {
  /** La tabla con, al menos, las monedas de `codes`. */
  table(codes?: readonly string[]): Promise<CurrencyDigitsTable>;
}
