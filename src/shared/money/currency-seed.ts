interface SeedCurrency {
  code: string;
  name: string;
  symbol: string;
}

interface SeedDigits {
  code: string;
  minorUnits: number;
  roundingDigits: number;
}

/**
 * Upserts del seed de `currencies` (DX-340). Los decimales (`minorUnits`,
 * `roundingDigits`) solo se escriben al CREAR la moneda: volver a sembrar
 * actualiza nombre y símbolo, nunca los decimales, para no pisar un cambio de
 * la regla hecho con una migración de datos (decisión del dueño).
 */
export function currencySeedUpserts(
  currencies: readonly SeedCurrency[],
  digits: readonly SeedDigits[],
) {
  const byCode = new Map(digits.map((d) => [d.code, d] as const));
  return currencies.map(({ code, name, symbol }) => {
    const reference = byCode.get(code);
    if (!reference) {
      throw new Error(`Moneda ${code} sin decimales de referencia`);
    }
    const { minorUnits, roundingDigits } = reference;
    return {
      where: { code },
      update: { name, symbol },
      create: { code, name, symbol, minorUnits, roundingDigits },
    };
  });
}
