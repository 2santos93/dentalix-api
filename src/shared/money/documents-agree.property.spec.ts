import fc from 'fast-check';
import {
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import { computeBalances } from '../../modules/account-statement/application/compute-account-statement';
import { discountForPercent } from '../../modules/discounts/domain/discount-policy';
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

// DX-340: para miles de planes aleatorios (todos sus ítems cobrables), el
// presupuesto, el detalle del plan, el saldo (`/balance`), el recibo y el
// estado de cuenta dan el MISMO total, que es la suma de las líneas
// redondeadas a los decimales de la moneda. JPY (0), EUR (2) y RSD (ISO 2,
// redondeo 0). Las monedas de 3 decimales (KWD, BHD…) no caben en
// Decimal(14,2): no están en el catálogo y se rechazan de forma explícita.

const PLAN_ID = 'plan-1';

interface Line {
  price: number;
  discount: number;
}

/** Un ítem: precio en unidades ISO de la moneda y, a veces, un % en bloque. */
function lineArb(currency: string): fc.Arbitrary<Line> {
  const { minorUnits, roundingDigits: digits } =
    REFERENCE_CURRENCY_DIGITS.of(currency);
  const minorCents = Number(unitCents(roundingDigits(minorUnits)));
  return fc
    .record({
      units: fc.integer({ min: 0, max: 50_000_000 / minorCents }),
      percent: fc.option(fc.integer({ min: 1, max: 10_000 }), {
        nil: undefined,
      }),
    })
    .map(({ units, percent }) => {
      const price = (units * minorCents) / 100;
      const discount =
        percent === undefined
          ? 0
          : discountForPercent(price, percent / 100, digits, 100);
      return { price, discount };
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
      status:
        i % 2 === 0
          ? TreatmentPlanItemStatus.ACCEPTED
          : TreatmentPlanItemStatus.DONE,
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
  const sum = (key: keyof Line) =>
    lines.reduce(
      (acc, line) => acc.plus(new Prisma.Decimal(line[key])),
      new Prisma.Decimal(0),
    );
  const billable = sum('price').minus(sum('discount')).toNumber();
  return computeBalances(
    {
      plans: [
        {
          id: PLAN_ID,
          status: TreatmentPlanStatus.ACCEPTED,
          currency,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          billable,
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

describe('presupuesto = plan = saldo = recibo = estado de cuenta (DX-340)', () => {
  it.each(['JPY', 'EUR', 'RSD'])(
    '%s: miles de planes aleatorios, el total es la suma de las líneas',
    async (currency) => {
      const digits = REFERENCE_CURRENCY_DIGITS.roundingDigits(currency);
      await fc.assert(
        fc.asyncProperty(
          fc.array(lineArb(currency), { maxLength: 25 }),
          async (lines) => {
            const total = linesTotal(lines);
            expect(await documents(currency, lines)).toEqual({
              quote: total,
              plan: total,
              balance: total,
              receipt: total,
              statement: total,
            });
            // Cada descuento ya está en la unidad de redondeo de la moneda.
            for (const { discount } of lines) {
              const cents = BigInt(Math.round(discount * 100));
              expect(cents % unitCents(digits)).toBe(0n);
            }
          },
        ),
        { numRuns: 2000 },
      );
    },
  );

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
