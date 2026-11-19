import {
  accrualLines,
  adjustmentLines,
  applyDeductions,
  baseAfterDeductions,
  commissionOf,
  frozenDeductions,
  labCostOf,
  planReleasedAt,
  totalsByCurrency,
  type CandidateItem,
  type SettledLine,
} from './commission-calculator';
import type { CommissionRuleTerms } from './commission-rule';

// DX-018: el cálculo de la liquidación, sin base de datos. Ejemplos en USD y
// VES (Venezuela, primer mercado), sede en Caracas (UTC−4).
const CARACAS = 'America/Caracas';
const OCT = { from: '2026-10-01', to: '2026-10-31' };

const terms = (
  over: Partial<CommissionRuleTerms> = {},
): CommissionRuleTerms => ({
  basis: 'COLLECTED',
  releaseMode: 'PER_ITEM',
  percent: 35,
  categories: [],
  deductLabCost: false,
  deductCardFee: false,
  ...over,
});

const item = (over: Partial<CandidateItem> = {}): CandidateItem => ({
  itemId: '00000000-0000-4000-8000-000000000001',
  planId: 'plan-1',
  patientId: 'patient-1',
  locationId: 'sede-1',
  timeZone: CARACAS,
  catalogCode: 'END-01',
  catalogLabel: 'Endodoncia unirradicular',
  category: 'Endodoncia',
  toothNumber: '11',
  currency: 'USD',
  net: 200,
  completedAt: new Date('2026-10-05T15:00:00Z'),
  producedPending: true,
  allocations: [],
  labCost: null,
  labCostSkippedCurrencies: [],
  ...over,
});

const allocation = (paymentId: string, amount: number, paidAt: string) => ({
  paymentId,
  amount,
  paidAt: new Date(paidAt),
  paymentAmount: amount,
  paymentCurrency: 'USD',
  cardFeePercent: null,
});

describe('commissionOf', () => {
  it('redondea al centavo: 35% de 33,33 = 11,67', () => {
    expect(commissionOf(33.33, 35)).toBe(11.67);
  });
  it('0% y 100%', () => {
    expect(commissionOf(150, 0)).toBe(0);
    expect(commissionOf(150, 100)).toBe(150);
  });
  it('porcentaje con decimales: 12,5% de 80 = 10', () => {
    expect(commissionOf(80, 12.5)).toBe(10);
  });
});

describe('accrualLines: lo cobrado por prestación (PER_ITEM)', () => {
  it('«Dra. X: 35% de lo cobrado»: una línea por abono imputado, con el detalle del abono', () => {
    const lines = accrualLines(
      [
        item({
          allocations: [
            allocation('pay-1', 100, '2026-10-06T14:00:00Z'),
            allocation('pay-2', 50, '2026-10-20T14:00:00Z'),
          ],
        }),
      ],
      terms(),
      OCT,
      new Map(),
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => [l.paymentId, l.base, l.amount])).toEqual([
      ['pay-1', 100, 35],
      ['pay-2', 50, 17.5],
    ]);
    expect(lines[0]).toMatchObject({
      kind: 'ACCRUAL',
      currency: 'USD',
      percent: 35,
      paymentAmount: 100,
      paymentCurrency: 'USD',
      releasedAt: new Date('2026-10-06T14:00:00Z'),
    });
  });

  it('un anticipo a un ítem aún no realizado espera: se libera al realizarse', () => {
    const lines = accrualLines(
      [
        item({
          completedAt: new Date('2026-11-03T15:00:00Z'),
          allocations: [allocation('pay-1', 100, '2026-10-02T14:00:00Z')],
        }),
      ],
      terms(),
      OCT,
      new Map(),
    );
    expect(lines).toEqual([]);
    const november = accrualLines(
      [
        item({
          completedAt: new Date('2026-11-03T15:00:00Z'),
          allocations: [allocation('pay-1', 100, '2026-10-02T14:00:00Z')],
        }),
      ],
      terms(),
      { from: '2026-11-01', to: '2026-11-30' },
      new Map(),
    );
    expect(november.map((l) => l.releasedAt)).toEqual([
      new Date('2026-11-03T15:00:00Z'),
    ]);
  });

  it('el día civil es el de la sede: 31/10 a las 22:00 en Caracas es octubre aunque en UTC sea noviembre', () => {
    const lines = accrualLines(
      [
        item({
          allocations: [allocation('pay-1', 100, '2026-11-01T02:00:00Z')],
        }),
      ],
      terms(),
      OCT,
      new Map(),
    );
    expect(lines).toHaveLength(1);
  });

  it('cada importe en la moneda del plan: un abono en VES imputado a un plan en USD liquida en USD', () => {
    const [line] = accrualLines(
      [
        item({
          allocations: [
            {
              paymentId: 'pay-ves',
              amount: 40,
              paidAt: new Date('2026-10-10T14:00:00Z'),
              paymentAmount: 14_600,
              paymentCurrency: 'VES',
              cardFeePercent: null,
            },
          ],
        }),
      ],
      terms(),
      OCT,
      new Map(),
    );
    expect(line).toMatchObject({
      currency: 'USD',
      base: 40,
      amount: 14,
      paymentAmount: 14_600,
      paymentCurrency: 'VES',
    });
  });
});

describe('accrualLines: lo producido', () => {
  it('se usan los ítems marcados como realizados en el período (precio − descuento)', () => {
    const lines = accrualLines(
      [
        item({ itemId: 'a', net: 200 }),
        item({
          itemId: 'b',
          net: 120,
          completedAt: new Date('2026-09-30T15:00:00Z'),
        }),
        item({ itemId: 'c', net: 80, producedPending: false }),
      ],
      terms({ basis: 'PRODUCED', percent: 30 }),
      OCT,
      new Map(),
    );
    expect(lines.map((l) => [l.itemId, l.base, l.amount, l.paymentId])).toEqual(
      [['a', 200, 60, null]],
    );
  });

  it('un ítem a precio 0 no genera línea', () => {
    expect(
      accrualLines(
        [item({ net: 0 })],
        terms({ basis: 'PRODUCED' }),
        OCT,
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe('porcentaje por categoría', () => {
  it('la categoría del catálogo con % propio (sin distinguir mayúsculas); el resto, el general', () => {
    const lines = accrualLines(
      [
        item({ itemId: 'endo', category: 'ENDODONCIA ', net: 100 }),
        item({ itemId: 'limp', category: 'Higiene', net: 100 }),
        item({ itemId: 'sin', category: null, net: 100 }),
      ],
      terms({
        basis: 'PRODUCED',
        percent: 30,
        categories: [{ category: 'Endodoncia', percent: 45 }],
      }),
      OCT,
      new Map(),
    );
    expect(Object.fromEntries(lines.map((l) => [l.itemId, l.amount]))).toEqual({
      endo: 45,
      limp: 30,
      sin: 30,
    });
  });
});

describe('PER_PLAN: solo con el plan completo y pagado', () => {
  const info = {
    planId: 'plan-1',
    pendingItems: 0,
    doneItems: 2,
    unpaidDoneItems: 0,
    lastCompletedAt: new Date('2026-10-05T15:00:00Z'),
    lastPaidAt: new Date('2026-10-12T15:00:00Z'),
  };

  it('la fecha es la más tardía entre el último realizado y el último abono', () => {
    expect(planReleasedAt(info)).toEqual(new Date('2026-10-12T15:00:00Z'));
    expect(planReleasedAt({ ...info, lastPaidAt: null })).toEqual(
      new Date('2026-10-05T15:00:00Z'),
    );
  });

  it('no se libera con ítems por hacer, sin realizados o con realizados sin pagar', () => {
    expect(planReleasedAt({ ...info, pendingItems: 1 })).toBeNull();
    expect(planReleasedAt({ ...info, doneItems: 0 })).toBeNull();
    expect(planReleasedAt({ ...info, unpaidDoneItems: 1 })).toBeNull();
  });

  it('todas las imputaciones del ítem se liberan juntas en la fecha del plan', () => {
    const released = new Date('2026-10-12T15:00:00Z');
    const lines = accrualLines(
      [
        item({
          allocations: [
            allocation('pay-1', 100, '2026-09-10T14:00:00Z'),
            allocation('pay-2', 100, '2026-10-12T15:00:00Z'),
          ],
        }),
      ],
      terms({ releaseMode: 'PER_PLAN' }),
      OCT,
      new Map([['plan-1', released]]),
    );
    expect(lines.map((l) => [l.paymentId, l.releasedAt])).toEqual([
      ['pay-1', released],
      ['pay-2', released],
    ]);
    expect(
      accrualLines(
        [
          item({
            allocations: [allocation('pay-1', 100, '2026-10-02T14:00:00Z')],
          }),
        ],
        terms({ releaseMode: 'PER_PLAN' }),
        OCT,
        new Map([['plan-1', null]]),
      ),
    ).toEqual([]);
  });

  it('producido por plan: el ítem cuenta cuando el plan se libera', () => {
    const lines = accrualLines(
      [item({ completedAt: new Date('2026-09-20T15:00:00Z') })],
      terms({ basis: 'PRODUCED', releaseMode: 'PER_PLAN', percent: 20 }),
      OCT,
      new Map([['plan-1', new Date('2026-10-12T15:00:00Z')]]),
    );
    expect(lines.map((l) => l.amount)).toEqual([40]);
  });
});

describe('descuentos (costo de laboratorio y comisión de la pasarela)', () => {
  it('con la regla activa descuenta el costo de laboratorio antes del %', () => {
    const lines = accrualLines(
      [item({ net: 300, labCost: 100 })],
      terms({ basis: 'PRODUCED', percent: 40, deductLabCost: true }),
      OCT,
      new Map(),
    );
    expect(lines.map((l) => [l.base, l.amount])).toEqual([[200, 80]]);
  });

  it('cobrado: el costo de laboratorio se descuenta en proporción a lo imputado', () => {
    expect(
      baseAfterDeductions(
        150,
        { deductLabCost: true, deductCardFee: false },
        {
          labCost: 100,
          itemNet: 300,
          cardFeePercent: null,
        },
      ),
    ).toBe(100);
  });

  it('la comisión de la pasarela se descuenta del abono', () => {
    expect(
      baseAfterDeductions(
        100,
        { deductLabCost: false, deductCardFee: true },
        {
          labCost: null,
          itemNet: 100,
          cardFeePercent: 3.5,
        },
      ),
    ).toBe(96.5);
  });

  it('sin la regla activa (o sin datos de origen) no descuenta nada; nunca deja la base negativa', () => {
    expect(
      baseAfterDeductions(
        100,
        { deductLabCost: false, deductCardFee: false },
        {
          labCost: 50,
          itemNet: 100,
          cardFeePercent: 3,
        },
      ),
    ).toBe(100);
    expect(
      baseAfterDeductions(
        100,
        { deductLabCost: true, deductCardFee: true },
        {
          labCost: null,
          itemNet: 100,
          cardFeePercent: null,
        },
      ),
    ).toBe(100);
    expect(
      baseAfterDeductions(
        100,
        { deductLabCost: true, deductCardFee: false },
        {
          labCost: 500,
          itemNet: 100,
          cardFeePercent: null,
        },
      ),
    ).toBe(0);
  });
});

describe('adjustmentLines: lo anulado después del cierre va en la siguiente', () => {
  const settled = (over: Partial<SettledLine> = {}): SettledLine => ({
    lineId: 'line-1',
    itemId: 'item-1',
    planId: 'plan-1',
    patientId: 'patient-1',
    paymentId: 'pay-1',
    locationId: 'sede-1',
    catalogCode: 'END-01',
    catalogLabel: 'Endodoncia',
    category: 'Endodoncia',
    toothNumber: '11',
    completedAt: new Date('2026-10-05T15:00:00Z'),
    paidAt: new Date('2026-10-06T14:00:00Z'),
    paymentAmount: 33.33,
    paymentCurrency: 'USD',
    currency: 'USD',
    percent: 35,
    settledBase: 33.33,
    settledAmount: 11.67,
    settledGross: 33.33,
    settledLabCost: 0,
    settledCardFee: 0,
    originalGross: 33.33,
    originalLabCost: 0,
    cardFeePercent: null,
    currentGross: 33.33,
    ...over,
  });

  it('sin cambios no hay ajuste', () => {
    expect(adjustmentLines([settled()])).toEqual([]);
  });

  it('abono anulado: ajuste negativo que deja la línea en 0 al centavo', () => {
    const [adj] = adjustmentLines([settled({ currentGross: 0 })]);
    expect(adj).toMatchObject({
      kind: 'ADJUSTMENT',
      adjustsLineId: 'line-1',
      base: -33.33,
      amount: -11.67,
      percent: 35,
      currency: 'USD',
      releasedAt: null,
    });
  });

  it('descuento cambiado tras el cierre: la diferencia con el % congelado', () => {
    const [adj] = adjustmentLines([
      settled({
        paymentId: null,
        settledBase: 200,
        settledAmount: 70,
        settledGross: 200,
        originalGross: 200,
        currentGross: 180,
      }),
    ]);
    expect(adj).toMatchObject({ base: -20, amount: -7 });
  });

  it('lo ya ajustado antes no se vuelve a ajustar (cuenta lo liquidado con sus ajustes)', () => {
    expect(
      adjustmentLines([
        settled({
          settledBase: 0,
          settledAmount: 0,
          settledGross: 0,
          currentGross: 0,
        }),
      ]),
    ).toEqual([]);
  });
});

describe('DX-018-bis: descuentos congelados en la línea', () => {
  it('labCostOf: suma los costos en la moneda del plan; los de otra moneda se avisan y no se convierten', () => {
    expect(
      labCostOf('USD', [
        { amount: 80.1, currency: 'USD' },
        { amount: 0.2, currency: 'USD' },
        { amount: 3_650, currency: 'VES' },
      ]),
    ).toEqual({ labCost: 80.3, skippedCurrencies: ['VES'] });
    expect(labCostOf('USD', [{ amount: 3_650, currency: 'VES' }])).toEqual({
      labCost: null,
      skippedCurrencies: ['VES'],
    });
    expect(labCostOf('USD', [])).toEqual({
      labCost: null,
      skippedCurrencies: [],
    });
  });

  it('la línea guarda base bruta, laboratorio y pasarela: base = bruta − lab − pasarela', () => {
    const lines = accrualLines(
      [
        item({
          net: 300,
          labCost: 90,
          labCostSkippedCurrencies: ['VES'],
          producedPending: false,
          allocations: [
            {
              ...allocation('pay-1', 100, '2026-10-06T14:00:00Z'),
              cardFeePercent: 3.5,
            },
          ],
        }),
      ],
      terms({ deductLabCost: true, deductCardFee: true, percent: 40 }),
      OCT,
      new Map(),
    );
    expect(lines).toHaveLength(1);
    // Lab: 90 × 100/300 = 30; pasarela: 3,5 % de 100 = 3,50.
    expect(lines[0]).toMatchObject({
      grossBase: 100,
      labCostDeducted: 30,
      cardFeePercent: 3.5,
      cardFeeDeducted: 3.5,
      base: 66.5,
      amount: 26.6,
      labCostSkippedCurrencies: ['VES'],
    });
  });

  it('sin «descontar laboratorio» no se avisa del costo en otra moneda ni se descuenta', () => {
    const [line] = accrualLines(
      [item({ labCost: 50, labCostSkippedCurrencies: ['VES'] })],
      terms({ basis: 'PRODUCED' }),
      OCT,
      new Map(),
    );
    expect(line).toMatchObject({
      grossBase: 200,
      labCostDeducted: 0,
      cardFeePercent: null,
      cardFeeDeducted: 0,
      base: 200,
      labCostSkippedCurrencies: [],
    });
  });

  it('producido: la pasarela no aplica (no hay abono)', () => {
    const [line] = accrualLines(
      [item({ net: 200 })],
      terms({ basis: 'PRODUCED', deductCardFee: true }),
      OCT,
      new Map(),
    );
    expect(line).toMatchObject({ cardFeePercent: null, base: 200 });
  });

  it('applyDeductions: el laboratorio se recorta a la base y la pasarela a lo que queda', () => {
    expect(
      applyDeductions(
        100,
        { deductLabCost: true, deductCardFee: true },
        { labCost: 98, itemNet: 100, cardFeePercent: 3 },
      ),
    ).toEqual({
      gross: 100,
      labCost: 98,
      cardFeePercent: 3,
      cardFee: 2,
      base: 0,
    });
  });

  it('abono anulado tras el cierre: el ajuste devuelve también lo descontado (la línea queda en 0)', () => {
    const line: SettledLine = {
      lineId: 'line-1',
      itemId: 'item-1',
      planId: 'plan-1',
      patientId: 'patient-1',
      paymentId: 'pay-1',
      locationId: 'sede-1',
      catalogCode: 'COR-01',
      catalogLabel: 'Corona',
      category: null,
      toothNumber: '16',
      completedAt: new Date('2026-10-05T15:00:00Z'),
      paidAt: new Date('2026-10-06T14:00:00Z'),
      paymentAmount: 100,
      paymentCurrency: 'USD',
      currency: 'USD',
      percent: 40,
      settledBase: 66.5,
      settledAmount: 26.6,
      settledGross: 100,
      settledLabCost: 30,
      settledCardFee: 3.5,
      originalGross: 100,
      originalLabCost: 30,
      cardFeePercent: 3.5,
      currentGross: 0,
    };
    expect(adjustmentLines([line])).toEqual([
      expect.objectContaining({
        kind: 'ADJUSTMENT',
        base: -66.5,
        amount: -26.6,
        grossBase: -100,
        labCostDeducted: -30,
        cardFeeDeducted: -3.5,
        cardFeePercent: 3.5,
      }),
    ]);
  });

  it('base bruta reducida tras el cierre: reaplica los descuentos congelados en proporción', () => {
    const [adj] = adjustmentLines([
      {
        lineId: 'line-1',
        itemId: 'item-1',
        planId: 'plan-1',
        patientId: 'patient-1',
        paymentId: null,
        locationId: 'sede-1',
        catalogCode: 'COR-01',
        catalogLabel: 'Corona',
        category: null,
        toothNumber: '16',
        completedAt: new Date('2026-10-05T15:00:00Z'),
        paidAt: null,
        paymentAmount: null,
        paymentCurrency: null,
        currency: 'USD',
        percent: 50,
        settledBase: 200,
        settledAmount: 100,
        settledGross: 300,
        settledLabCost: 100,
        settledCardFee: 0,
        originalGross: 300,
        originalLabCost: 100,
        cardFeePercent: null,
        // Descuento al paciente tras el cierre: 300 → 150 (lab congelado: 50).
        currentGross: 150,
      },
    ]);
    expect(adj).toMatchObject({
      base: -100,
      amount: -50,
      grossBase: -150,
      labCostDeducted: -50,
      cardFeeDeducted: 0,
    });
    expect(
      frozenDeductions({
        currentGross: 150,
        originalGross: 300,
        originalLabCost: 100,
        cardFeePercent: null,
      }).base,
    ).toBe(100);
  });
});

describe('totalsByCurrency', () => {
  it('agrupa por moneda y nunca suma monedas distintas; separa devengado y ajustes', () => {
    expect(
      totalsByCurrency([
        { kind: 'ACCRUAL', currency: 'USD', amount: 35 },
        { kind: 'ACCRUAL', currency: 'USD', amount: 0.1 },
        { kind: 'ACCRUAL', currency: 'USD', amount: 0.2 },
        { kind: 'ADJUSTMENT', currency: 'USD', amount: -11.67 },
        { kind: 'ACCRUAL', currency: 'VES', amount: 5_110 },
      ]),
    ).toEqual([
      {
        currency: 'USD',
        accrued: 35.3,
        adjustments: -11.67,
        total: 23.63,
        lines: 4,
      },
      {
        currency: 'VES',
        accrued: 5_110,
        adjustments: 0,
        total: 5_110,
        lines: 1,
      },
    ]);
  });
});
