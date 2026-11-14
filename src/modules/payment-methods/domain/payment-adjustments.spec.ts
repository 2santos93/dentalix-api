import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
} from '@prisma/client';
import { roundingDigits } from '../../../shared/money/line-rounding';
import {
  adjustmentLabelError,
  collectedAmount,
  computePaymentAdjustments,
  fitsCurrencyDigits,
  isValidAdjustmentPercent,
  type AdjustmentRule,
} from './payment-adjustments';

// DX-516: los mismos vectores (copia byte a byte en la web,
// src/lib/payments/payment-adjustment-vectors.json, que comprueba
// scripts/check-api-reference-sync.mjs de la web) fijan la paridad API/web
// del cálculo de los ajustes por medio de pago.

interface Vectors {
  currencies: Record<string, { roundingDigits: number }>;
  cases: {
    name: string;
    amount: number;
    currency: string;
    rules: {
      type: PaymentAdjustmentType;
      label: string;
      calculation: PaymentAdjustmentCalculation;
      percent: number | null;
      fixedAmount: number | null;
      fixedCurrency: string | null;
      active: boolean;
    }[];
    lines: { type: PaymentAdjustmentType; label: string; amount: number }[];
    collected: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'payment-adjustment-vectors.json'), 'utf8'),
) as Vectors;

describe('ajustes por medio de pago (DX-516)', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    'vector: %s',
    (_name, c) => {
      const rules: AdjustmentRule[] = c.rules.map((rule, i) => ({
        ...rule,
        id: `rule-${i}`,
      }));
      const digits = roundingDigits(
        vectors.currencies[c.currency].roundingDigits,
      );
      const lines = computePaymentAdjustments(
        rules,
        c.amount,
        c.currency,
        digits,
      );
      expect(
        lines.map((l) => ({ type: l.type, label: l.label, amount: l.amount })),
      ).toEqual(c.lines);
      expect(collectedAmount(c.amount, lines)).toBe(c.collected);
      // Cada línea lleva la base (el importe) y la moneda del abono, en orden.
      lines.forEach((line, i) => {
        expect(line.base).toBe(c.amount);
        expect(line.currency).toBe(c.currency);
        expect(line.position).toBe(i + 1);
      });
    },
  );

  it('la línea congela el cálculo tal como estaba (porcentaje o fijo) y su origen', () => {
    const [pct, fixed] = computePaymentAdjustments(
      [
        {
          id: 'a',
          type: 'TAX',
          label: 'T',
          calculation: 'PERCENT',
          percent: 3,
          fixedAmount: null,
          fixedCurrency: null,
          active: true,
        },
        {
          id: 'b',
          type: 'SURCHARGE',
          label: 'S',
          calculation: 'FIXED',
          percent: null,
          fixedAmount: 1.5,
          fixedCurrency: 'usd',
          active: true,
        },
      ],
      10,
      'USD',
      2,
    );
    expect(pct).toMatchObject({
      sourceAdjustmentId: 'a',
      percent: 3,
      fixedAmount: null,
    });
    expect(fixed).toMatchObject({
      sourceAdjustmentId: 'b',
      percent: null,
      fixedAmount: 1.5,
      amount: 1.5,
    });
  });

  it('valida la etiqueta: obligatoria, hasta 40 caracteres, una línea', () => {
    expect(adjustmentLabelError('Impuesto 3 %')).toBeNull();
    expect(adjustmentLabelError('   ')).not.toBeNull();
    expect(adjustmentLabelError('x'.repeat(41))).not.toBeNull();
    expect(adjustmentLabelError('x'.repeat(40))).toBeNull();
    expect(adjustmentLabelError('a\nb')).not.toBeNull();
  });

  it('valida el porcentaje: (0, 100] con hasta 2 decimales', () => {
    for (const ok of [0.01, 3, 7.5, 12.34, 100]) {
      expect(isValidAdjustmentPercent(ok)).toBe(true);
    }
    for (const bad of [0, -1, 100.01, 1.234, Number.NaN, Infinity]) {
      expect(isValidAdjustmentPercent(bad)).toBe(false);
    }
  });

  it('un importe fijo respeta los decimales de redondeo de su moneda', () => {
    expect(fitsCurrencyDigits(2.5, 2)).toBe(true);
    expect(fitsCurrencyDigits(2.55, 1)).toBe(false);
    expect(fitsCurrencyDigits(2.5, 1)).toBe(true);
    expect(fitsCurrencyDigits(2.5, 0)).toBe(false);
    expect(fitsCurrencyDigits(300, 0)).toBe(true);
  });
});
