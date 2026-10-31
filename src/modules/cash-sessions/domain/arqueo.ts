import type { PaymentMethod } from '@prisma/client';
import { fromCents, toCents } from '../../../shared/money/money';

/*
 * Arqueo de una caja (DX-027): lo que DEBERÍA haber por (moneda, método) y la
 * diferencia con lo contado. Todo en céntimos enteros: DECIMAL(14,2) cabe de
 * sobra en un entero exacto de JS (< 2^53), y así una suma de abonos nunca
 * arrastra el error del coma flotante.
 */

/** Orden fijo de los métodos en el arqueo y en el informe. */
export const ARQUEO_METHODS: readonly PaymentMethod[] = [
  'CASH',
  'CARD',
  'TRANSFER',
  'OTHER',
];

/** Un abono sin método (anterior a que el formulario lo pidiera) es «Otro». */
export function methodBucket(method: PaymentMethod | null): PaymentMethod {
  return method ?? 'OTHER';
}

/** Alias de la caja de `toCents` (src/shared/money). */
export const centsOf = toCents;

export { fromCents };

export interface ArqueoSource {
  /** Fondo inicial por moneda: siempre en efectivo. */
  floats: { currency: string; cents: number }[];
  /** Abonos que cuentan en la caja (ver la regla en el repositorio). */
  payments: { currency: string; method: PaymentMethod | null; cents: number }[];
  /** Ajustes que entraron en esta caja (con signo). */
  adjustments: { currency: string; method: PaymentMethod; cents: number }[];
  /**
   * Salidas de caja menor (DX-274): pagos de gastos desde el cajón, siempre en
   * efectivo y en positivo; restan. Cuentan como los abonos (ver la regla en
   * el repositorio): una anulada con la caja ya cerrada sigue restando aquí.
   */
  outflows: { currency: string; cents: number }[];
}

export interface ExpectedLine {
  currency: string;
  method: PaymentMethod;
  openingCents: number;
  paymentsCents: number;
  paymentsCount: number;
  adjustmentsCents: number;
  /** Salidas de caja (en positivo: se restan). */
  outflowsCents: number;
  outflowsCount: number;
  expectedCents: number;
}

export interface CountedAmount {
  currency: string;
  method: PaymentMethod;
  cents: number;
}

export interface ArqueoLine extends ExpectedLine {
  countedCents: number;
  differenceCents: number;
}

export interface ArqueoResult {
  lines: ArqueoLine[];
  hasDifference: boolean;
}

const keyOf = (currency: string, method: PaymentMethod) =>
  `${currency}|${method}`;

function emptyLine(currency: string, method: PaymentMethod): ExpectedLine {
  return {
    currency,
    method,
    openingCents: 0,
    paymentsCents: 0,
    paymentsCount: 0,
    adjustmentsCents: 0,
    outflowsCents: 0,
    outflowsCount: 0,
    expectedCents: 0,
  };
}

function byCurrencyThenMethod(
  a: { currency: string; method: PaymentMethod },
  b: { currency: string; method: PaymentMethod },
): number {
  return (
    a.currency.localeCompare(b.currency) ||
    ARQUEO_METHODS.indexOf(a.method) - ARQUEO_METHODS.indexOf(b.method)
  );
}

/**
 * Lo esperado por (moneda, método): fondo + abonos + ajustes − salidas. Puede
 * quedar negativo (R5 de DX-274): no se rechaza, para no dar un oráculo del
 * esperado con el arqueo ciego.
 */
export function expectedLines(source: ArqueoSource): ExpectedLine[] {
  const lines = new Map<string, ExpectedLine>();
  const lineFor = (currency: string, method: PaymentMethod) => {
    const key = keyOf(currency, method);
    let line = lines.get(key);
    if (!line) {
      line = emptyLine(currency, method);
      lines.set(key, line);
    }
    return line;
  };
  for (const float of source.floats) {
    lineFor(float.currency, 'CASH').openingCents += float.cents;
  }
  for (const payment of source.payments) {
    const line = lineFor(payment.currency, methodBucket(payment.method));
    line.paymentsCents += payment.cents;
    line.paymentsCount += 1;
  }
  for (const adjustment of source.adjustments) {
    lineFor(adjustment.currency, adjustment.method).adjustmentsCents +=
      adjustment.cents;
  }
  for (const outflow of source.outflows) {
    const line = lineFor(outflow.currency, 'CASH');
    line.outflowsCents += outflow.cents;
    line.outflowsCount += 1;
  }
  return [...lines.values()]
    .map((line) => ({
      ...line,
      expectedCents:
        line.openingCents +
        line.paymentsCents +
        line.adjustmentsCents -
        line.outflowsCents,
    }))
    .sort(byCurrencyThenMethod);
}

/**
 * El arqueo: cada par esperado con lo contado (0 si no se contó) y cada par
 * contado sin esperado (esperado 0). Lanza `RangeError` si un par se contó
 * dos veces: es un error del cliente.
 */
export function arqueo(
  expected: readonly ExpectedLine[],
  counted: readonly CountedAmount[],
): ArqueoResult {
  const countedByKey = new Map<string, number>();
  for (const count of counted) {
    const key = keyOf(count.currency, count.method);
    if (countedByKey.has(key)) {
      throw new RangeError(
        `${count.currency} ${count.method} está contado dos veces`,
      );
    }
    countedByKey.set(key, count.cents);
  }
  const lines = new Map<string, ExpectedLine>(
    expected.map((line) => [keyOf(line.currency, line.method), line]),
  );
  for (const count of counted) {
    const key = keyOf(count.currency, count.method);
    if (!lines.has(key))
      lines.set(key, emptyLine(count.currency, count.method));
  }
  const result = [...lines.entries()]
    .map(([key, line]) => {
      const countedCents = countedByKey.get(key) ?? 0;
      return {
        ...line,
        countedCents,
        differenceCents: countedCents - line.expectedCents,
      };
    })
    .sort(byCurrencyThenMethod);
  return {
    lines: result,
    hasDifference: result.some((line) => line.differenceCents !== 0),
  };
}
