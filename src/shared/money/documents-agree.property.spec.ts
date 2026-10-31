import fc from 'fast-check';
import {
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import { computeBalances } from '../../modules/account-statement/application/compute-account-statement';
import { discountForPercent } from '../../modules/discounts/domain/discount-policy';
import { percentPrice } from '../../modules/treatment-plans/domain/pricing/resolve-item-price';
import { ReceiptPlanBalanceCalculator } from '../../modules/payments/application/receipts/receipt-plan-balance';
import type { ConvertAmountUseCase } from '../../modules/exchange/application/use-cases/convert-amount.use-case';
import { GetPlanBalanceUseCase } from '../../modules/payments/application/use-cases/get-plan-balance.use-case';
import type { PaymentRepository } from '../../modules/payments/domain/ports/payment-repository.port';
import type { PlanAllocationRepository } from '../../modules/payments/domain/ports/plan-allocation-repository.port';
import { GetTreatmentPlanUseCase } from '../../modules/treatment-plans/application/use-cases/get-treatment-plan.use-case';
import type { TreatmentPlanWithItems } from '../../modules/treatment-plans/domain/entities/treatment-plan.entity';
import type { TreatmentPlanRepository } from '../../modules/treatment-plans/domain/ports/treatment-plan-repository.port';
import { buildQuoteContent } from '../../modules/treatment-plans/domain/plan-quote';
import { linesTotal, roundingDigits, unitCents } from './line-rounding';
import { REFERENCE_CURRENCY_DIGITS } from './__fixtures__/reference-currency-digits';
import {
  oldBillable,
  oldDiscountForPercent,
  oldPercentPrice,
  oldPlanTotal,
} from './__fixtures__/pre-dx340-oracle';

// DX-340: para miles de planes aleatorios, con ítems cobrables (ACCEPTED,
// DONE) y no cobrables (PROPOSED), descuentos en bloque y descuentos
// manuales con céntimos (también en JPY), cada documento da lo MISMO que el
// código de origin/main, copiado y congelado en `pre-dx340-oracle.ts` (no se
// compara el código nuevo consigo mismo):
//   - presupuesto y detalle del plan = total de main (todos los ítems);
//   - saldo (`/balance`), recibo y estado de cuenta (Σ en Decimal, como la
//     BD) = cobrable de main (solo ACCEPTED/DONE).
// En JPY (0), EUR (2) y RSD (ISO 2, redondeo 0) con miles de planes, y en
// TODAS las monedas del catálogo con menos. Además, descuento en bloque y
// precio por convenio = los de main en todas las monedas. Las de 3 decimales
// (KWD, BHD…) no caben en Decimal(14,2): fuera del catálogo y rechazadas.

const PLAN_ID = 'plan-1';

type ItemStatus = 'PROPOSED' | 'ACCEPTED' | 'DONE';

interface Line {
  status: ItemStatus;
  price: number;
  discount: number;
}

const BILLABLE: ReadonlySet<ItemStatus> = new Set(['ACCEPTED', 'DONE']);

/**
 * Un ítem: precio en unidades ISO de la moneda (o con céntimos, que los
 * campos admiten en cualquier moneda, DX-241), un estado cualquiera y un
 * descuento nulo, en bloque (con la regla de main) o manual con céntimos.
 */
function lineArb(currency: string): fc.Arbitrary<Line> {
  const { minorUnits, roundingDigits: digits } =
    REFERENCE_CURRENCY_DIGITS.of(currency);
  const minorCents = Number(unitCents(roundingDigits(minorUnits)));
  return fc
    .record({
      status: fc.constantFrom<ItemStatus>('PROPOSED', 'ACCEPTED', 'DONE'),
      units: fc.integer({ min: 0, max: 50_000_000 / minorCents }),
      extraCents: fc.option(fc.integer({ min: 1, max: 99 }), {
        nil: undefined,
      }),
      discount: fc.oneof(
        fc.constant({ kind: 'none' as const }),
        fc
          .integer({ min: 1, max: 10_000 })
          .map((bp) => ({ kind: 'bulk' as const, bp })),
        fc
          .integer({ min: 0, max: 10_000 })
          .map((bp) => ({ kind: 'manual' as const, bp })),
      ),
    })
    .map(({ status, units, extraCents, discount }) => {
      const price = (units * minorCents + (extraCents ?? 0)) / 100;
      let amount = 0;
      if (discount.kind === 'bulk') {
        const fromMain = oldDiscountForPercent(
          price,
          discount.bp / 100,
          currency,
          100,
        );
        expect(discountForPercent(price, discount.bp / 100, digits, 100)).toBe(
          fromMain,
        );
        amount = fromMain;
      } else if (discount.kind === 'manual') {
        // Un descuento tecleado a mano, con céntimos, hasta el precio.
        amount =
          Math.floor((Math.round(price * 100) * discount.bp) / 10000) / 100;
      }
      return { status, price, discount: amount };
    });
}

function planOf(currency: string, lines: Line[]): TreatmentPlanWithItems {
  return {
    id: PLAN_ID,
    status: TreatmentPlanStatus.ACCEPTED,
    currency,
    acceptance: null,
    items: lines.map((line, i) => ({
      id: `item-${i}`,
      status: TreatmentPlanItemStatus[line.status],
      price: line.price,
      discount: line.discount,
    })),
  } as unknown as TreatmentPlanWithItems;
}

function quoteNet(currency: string, lines: Line[]): number {
  return buildQuoteContent(
    {
      planId: PLAN_ID,
      patientId: 'patient-1',
      currency,
      clinicName: 'Clínica',
      location: { id: 'loc-1', name: 'Sede', address: null },
      patient: { name: 'Paciente', document: null },
      professionalName: null,
      items: lines.map((line, i) => ({
        id: `item-${i}`,
        toothNumber: '11',
        surfaces: [],
        procedure: 'Procedimiento',
        price: line.price,
        discount: line.discount,
        basePrice: null,
        referencePrice: null,
        agreementName: null,
        agreementPayerName: null,
      })),
    },
    '2026-10-31',
  ).totals[0].net;
}

/** El estado de cuenta: Σ precio − Σ descuento en Decimal, como la BD. */
function statementBudgeted(currency: string, lines: Line[]): number {
  const billable = lines.filter((line) => BILLABLE.has(line.status));
  const sum = (key: 'price' | 'discount') =>
    billable.reduce(
      (acc, line) => acc.plus(new Prisma.Decimal(line[key])),
      new Prisma.Decimal(0),
    );
  return computeBalances(
    {
      plans: [
        {
          id: PLAN_ID,
          status: TreatmentPlanStatus.ACCEPTED,
          currency,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          billable: sum('price').minus(sum('discount')).toNumber(),
        },
      ],
      payments: [],
      paymentPlans: [],
    },
    new Date('2026-10-31T00:00:00Z'),
  ).plans[0].budgeted;
}

async function documents(currency: string, lines: Line[]) {
  const plan = planOf(currency, lines);
  const getPlan = new GetTreatmentPlanUseCase({
    findPlanById: () => Promise.resolve(plan),
  } as unknown as TreatmentPlanRepository);
  const balance = new GetPlanBalanceUseCase(
    { listByPlan: () => Promise.resolve([]) } as unknown as PaymentRepository,
    getPlan,
    // Sin abonos no se convierte nada: el convertidor no se llama.
    { memoized: () => ({}) } as unknown as ConvertAmountUseCase,
    {} as PlanAllocationRepository,
  );
  const receipt = await new ReceiptPlanBalanceCalculator(balance).afterPayment(
    PLAN_ID,
    0,
  );
  return {
    quote: quoteNet(currency, lines),
    plan: (await getPlan.execute(PLAN_ID)).total,
    balance: (await balance.execute(PLAN_ID)).billable,
    receipt: receipt?.billable,
    statement: statementBudgeted(currency, lines),
  };
}

async function expectSameAsMain(currency: string, lines: Line[]) {
  const total = oldPlanTotal(lines);
  const billable = oldBillable(lines);
  expect(await documents(currency, lines)).toEqual({
    quote: total,
    plan: total,
    balance: billable,
    receipt: billable,
    statement: billable,
  });
  // Y la regla nueva lo explica: suma exacta de las líneas.
  expect(linesTotal(lines)).toBe(total);
  expect(linesTotal(lines.filter((l) => BILLABLE.has(l.status)))).toBe(
    billable,
  );
}

describe('presupuesto = plan = saldo = recibo = estado de cuenta = main (DX-340)', () => {
  it.each(['JPY', 'EUR', 'RSD'])(
    '%s: miles de planes aleatorios dan lo mismo que el código congelado de main',
    async (currency) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(lineArb(currency), { maxLength: 25 }),
          (lines) => expectSameAsMain(currency, lines),
        ),
        { numRuns: 2000 },
      );
    },
  );

  it('todas las monedas del catálogo: documentos = main', async () => {
    for (const { code } of CURRENCY_DIGITS) {
      await fc.assert(
        fc.asyncProperty(fc.array(lineArb(code), { maxLength: 12 }), (lines) =>
          expectSameAsMain(code, lines),
        ),
        { numRuns: 40 },
      );
    }
  });

  it('todas las monedas del catálogo: descuento en bloque y precio por convenio = main', () => {
    const price = fc.integer({ min: 0, max: 99_999_999 }).map((c) => c / 100);
    const percent = fc.integer({ min: 0, max: 10_000 }).map((bp) => bp / 100);
    for (const { code } of CURRENCY_DIGITS) {
      const digits = REFERENCE_CURRENCY_DIGITS.roundingDigits(code);
      fc.assert(
        fc.property(price, percent, percent, (p, pct, cap) => {
          expect(discountForPercent(p, pct, digits, cap)).toBe(
            oldDiscountForPercent(p, pct, code, cap),
          );
          expect(percentPrice(p, pct, digits)).toBe(
            oldPercentPrice(p, pct, code),
          );
        }),
        { numRuns: 300 },
      );
    }
  });

  it('una moneda de 3 decimales no cabe: fuera del catálogo y rechazada', () => {
    for (const code of ['KWD', 'BHD', 'JOD', 'OMR', 'TND', 'IQD', 'LYD']) {
      expect(CURRENCY_DIGITS.some((c) => c.code === code)).toBe(false);
      expect(() => REFERENCE_CURRENCY_DIGITS.of(code)).toThrow(
        /sin decimales en el catálogo/,
      );
    }
    expect(() => roundingDigits(3)).toThrow(/como mucho 2 decimales/);
  });
});
