import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicRole } from '@prisma/client';
import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import {
  checkItemDiscount,
  discountForPercent,
} from '../../modules/discounts/domain/discount-policy';
import { percentPrice } from '../../modules/treatment-plans/domain/pricing/resolve-item-price';
import { linesTotal, roundingDigits } from './line-rounding';

// DX-340: los mismos vectores (copia byte a byte en la web,
// src/lib/money/rounding-vectors.json, que comprueba
// scripts/check-api-reference-sync.mjs de la web) fijan la paridad API/web
// del redondeo: RSD, JPY, EUR (y COP) con 123,45 × 7,5 %, límites del
// descuento y total de líneas. Ninguno depende del Intl del host.

interface Vectors {
  currencies: Record<string, { minorUnits: number; roundingDigits: number }>;
  discountForPercent: {
    currency: string;
    price: number;
    percent: number;
    capPercent: number;
    discount: number;
  }[];
  percentPrice: {
    currency: string;
    base: number;
    percent: number;
    price: number;
  }[];
  alternativeRoundingDigits: {
    currency: string;
    roundingDigits: number;
    price: number;
    percent: number;
    capPercent: number;
    discount: number;
  }[];
  discountLimits: {
    price: number;
    discount: number;
    percent: number;
    exceeds: boolean;
  }[];
  linesTotal: {
    currency: string;
    lines: { price: number; discount: number }[];
    total: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'rounding-vectors.json'), 'utf8'),
) as Vectors;

const digitsOf = (currency: string) =>
  roundingDigits(vectors.currencies[currency].roundingDigits);

describe('vectores de redondeo compartidos con la web (DX-340)', () => {
  it('los decimales de cada moneda son los de la referencia versionada', () => {
    for (const [code, digits] of Object.entries(vectors.currencies)) {
      const reference = CURRENCY_DIGITS.find((c) => c.code === code);
      expect({ code, ...digits }).toEqual(reference);
    }
    // RSD: 2 minor units ISO (SIX List One), redondeo vigente a 0.
    expect(vectors.currencies.RSD).toEqual({
      minorUnits: 2,
      roundingDigits: 0,
    });
  });

  it.each(vectors.discountForPercent)(
    'descuento en bloque $currency: $percent % de $price (tope $capPercent %) = $discount',
    ({ currency, price, percent, capPercent, discount }) => {
      expect(
        discountForPercent(price, percent, digitsOf(currency), capPercent),
      ).toBe(discount);
    },
  );

  it('123,45 × 7,5 % es 9 en RSD (vigente) y sería 9,26 con 2 dígitos', () => {
    const rsd = vectors.discountForPercent.find(
      (v) => v.currency === 'RSD' && v.price === 123.45 && v.percent === 7.5,
    );
    expect(rsd?.discount).toBe(9);
    for (const alt of vectors.alternativeRoundingDigits) {
      expect(
        discountForPercent(
          alt.price,
          alt.percent,
          roundingDigits(alt.roundingDigits),
          alt.capPercent,
        ),
      ).toBe(alt.discount);
    }
  });

  it.each(vectors.percentPrice)(
    'precio por convenio $currency: $base − $percent % = $price',
    ({ currency, base, percent, price }) => {
      expect(percentPrice(base, percent, digitsOf(currency))).toBe(price);
    },
  );

  it.each(vectors.discountLimits)(
    'límite: $discount sobre $price supera el $percent %? $exceeds',
    ({ price, discount, percent, exceeds }) => {
      const policy = {
        maxPercentByRole: {
          [ClinicRole.ADMIN]: percent,
          [ClinicRole.DENTIST]: percent,
          [ClinicRole.ASSISTANT]: percent,
          [ClinicRole.RECEPTION]: percent,
        },
        reasonRequiredAbovePercent: 100,
      };
      const result = checkItemDiscount(policy, ClinicRole.DENTIST, {
        price,
        discount,
        reason: null,
        reasonNote: null,
      });
      expect(result.kind === 'over-cap').toBe(exceeds);
    },
  );

  it.each(vectors.linesTotal)(
    'total de líneas en $currency = $total',
    ({ lines, total }) => {
      expect(linesTotal(lines)).toBe(total);
    },
  );
});
