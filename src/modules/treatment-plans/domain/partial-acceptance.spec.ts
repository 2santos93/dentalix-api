import fc from 'fast-check';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { toCents } from '../../../shared/money/money';
import type { QuoteSourceItem } from './plan-quote';
import {
  PARTIAL_ALL_CHOSEN_MESSAGE,
  PARTIAL_ITEMS_MAX,
  PARTIAL_NONE_CHOSEN_MESSAGE,
  PARTIAL_NOT_PROPOSED_LEFT_OUT_MESSAGE,
  PARTIAL_PLAN_ACCEPTED_CODE,
  PARTIAL_PLAN_NOT_PRESENTED_CODE,
  PartialAcceptanceError,
  decidePartial,
  splitItems,
  splitTotals,
  type PartialPlanState,
} from './partial-acceptance';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const C = 'aaaaaaaa-0000-4000-8000-000000000003';
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000009';

const NO_FACTS = {
  hasLivePayments: false,
  hasActivePaymentPlan: false,
  hasCreditEntries: false,
};

function plan(overrides: Partial<PartialPlanState> = {}): PartialPlanState {
  return {
    status: TreatmentPlanStatus.PRESENTED,
    signed: false,
    facts: NO_FACTS,
    items: [
      { id: A, status: TreatmentPlanItemStatus.PROPOSED },
      { id: B, status: TreatmentPlanItemStatus.PROPOSED },
      { id: C, status: TreatmentPlanItemStatus.PROPOSED },
    ],
    ...overrides,
  };
}

function failure(run: () => unknown): PartialAcceptanceError {
  try {
    run();
  } catch (error) {
    if (error instanceof PartialAcceptanceError) return error;
    throw error;
  }
  throw new Error('no lanzó');
}

describe('decidePartial (DX-417)', () => {
  it('parte en aceptados y pendientes, en el orden del plan', () => {
    expect(decidePartial(plan(), [C, A])).toEqual({
      acceptedItemIds: [A, C],
      pendingItemIds: [B],
    });
  });

  it('acepta los ids en mayúsculas y repetidos', () => {
    expect(decidePartial(plan(), [B.toUpperCase(), B])).toEqual({
      acceptedItemIds: [B],
      pendingItemIds: [A, C],
    });
  });

  it.each([
    TreatmentPlanStatus.DRAFT,
    TreatmentPlanStatus.REJECTED,
    TreatmentPlanStatus.COMPLETED,
    TreatmentPlanStatus.CANCELLED,
  ])('solo un PRESENTED: %s da 409 PARTIAL_PLAN_NOT_PRESENTED', (status) => {
    const error = failure(() => decidePartial(plan({ status }), [A]));
    expect(error).toMatchObject({
      kind: 'CONFLICT',
      code: PARTIAL_PLAN_NOT_PRESENTED_CODE,
      message: 'Solo un presupuesto presentado se acepta en parte.',
    });
  });

  it('ya aceptado (sin firma) o firmado: 409 PARTIAL_PLAN_ALREADY_ACCEPTED', () => {
    for (const state of [
      plan({ status: TreatmentPlanStatus.ACCEPTED }),
      plan({ signed: true }),
    ]) {
      expect(failure(() => decidePartial(state, [A]))).toMatchObject({
        kind: 'CONFLICT',
        code: PARTIAL_PLAN_ACCEPTED_CODE,
        message: 'El plan ya está aceptado: no se puede aceptar en parte.',
      });
    }
  });

  it.each([
    [
      { hasLivePayments: true },
      'El plan tiene abonos registrados: no se acepta en parte. Anula los abonos o acéptalo entero.',
    ],
    [
      { hasActivePaymentPlan: true },
      'El plan tiene un plan de cuotas activo: no se acepta en parte. Cancélalo o acéptalo entero.',
    ],
    [
      { hasCreditEntries: true },
      'El plan tiene saldo a favor traspasado o devuelto: no se acepta en parte.',
    ],
  ])('con %o: 409 y nada se parte', (facts, message) => {
    expect(
      failure(() =>
        decidePartial(plan({ facts: { ...NO_FACTS, ...facts } }), [A]),
      ),
    ).toMatchObject({ kind: 'CONFLICT', message });
  });

  it('un ítem ajeno al plan: 404', () => {
    expect(failure(() => decidePartial(plan(), [A, FOREIGN]))).toMatchObject({
      kind: 'NOT_FOUND',
      message: 'Algún ítem no existe o no es de este plan de tratamiento.',
    });
  });

  it('ninguno elegido: 400', () => {
    expect(failure(() => decidePartial(plan(), []))).toMatchObject({
      kind: 'BAD_REQUEST',
      message: PARTIAL_NONE_CHOSEN_MESSAGE,
    });
  });

  it('todos elegidos: 400 «acéptalo entero»', () => {
    expect(failure(() => decidePartial(plan(), [A, B, C]))).toMatchObject({
      kind: 'BAD_REQUEST',
      message: 'Has elegido todos los procedimientos: acéptalo entero.',
    });
    expect(PARTIAL_ALL_CHOSEN_MESSAGE).toBe(
      'Has elegido todos los procedimientos: acéptalo entero.',
    );
  });

  it('un ítem ACCEPTED o DONE dejado fuera: 400', () => {
    for (const status of [
      TreatmentPlanItemStatus.ACCEPTED,
      TreatmentPlanItemStatus.DONE,
    ]) {
      const state = plan({
        items: [
          { id: A, status: TreatmentPlanItemStatus.PROPOSED },
          { id: B, status },
          { id: C, status: TreatmentPlanItemStatus.PROPOSED },
        ],
      });
      expect(failure(() => decidePartial(state, [A]))).toMatchObject({
        kind: 'BAD_REQUEST',
        message:
          'Los procedimientos ya aceptados o realizados forman parte de lo aceptado.',
      });
      expect(PARTIAL_NOT_PROPOSED_LEFT_OUT_MESSAGE).toContain('realizados');
      // Elegido, va con lo aceptado.
      expect(decidePartial(state, [A, B])).toEqual({
        acceptedItemIds: [A, B],
        pendingItemIds: [C],
      });
    }
  });

  it(`más de ${PARTIAL_ITEMS_MAX} ids: 400`, () => {
    const many = Array.from(
      { length: PARTIAL_ITEMS_MAX + 1 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(failure(() => decidePartial(plan(), many)).kind).toBe('BAD_REQUEST');
  });

  it('ya aceptado va antes que los ids (firma concurrente: 409, no 404)', () => {
    expect(
      failure(() =>
        decidePartial(plan({ status: TreatmentPlanStatus.ACCEPTED }), [
          FOREIGN,
        ]),
      ).kind,
    ).toBe('CONFLICT');
  });

  it('un id ajeno es 404 antes que el resto del estado del plan (no filtra nada)', () => {
    expect(
      failure(() =>
        decidePartial(plan({ status: TreatmentPlanStatus.DRAFT }), [FOREIGN]),
      ).kind,
    ).toBe('NOT_FOUND');
  });
});

describe('splitItems', () => {
  it('reparte las filas en el orden en que llegan', () => {
    const rows = [{ id: A }, { id: B }, { id: C }];
    expect(
      splitItems(rows, { acceptedItemIds: [C, A], pendingItemIds: [B] }),
    ).toEqual({ accepted: [{ id: A }, { id: C }], pending: [{ id: B }] });
  });
});

/** Un ítem del presupuesto con lo que importa a los totales. */
function item(
  id: string,
  money: Partial<QuoteSourceItem> & Pick<QuoteSourceItem, 'price'>,
): QuoteSourceItem {
  return {
    id,
    toothNumber: '11',
    surfaces: [],
    procedure: 'Resina',
    discount: 0,
    basePrice: null,
    referencePrice: null,
    agreementName: null,
    agreementPayerName: null,
    listPriceCurrency: null,
    ...money,
  };
}

describe('splitTotals: aceptado + pendiente = original', () => {
  it('ejemplo en USD con descuento y convenio', () => {
    const items = [
      item(A, { price: 450, discount: 45.5 }),
      item(B, {
        price: 120,
        basePrice: 150,
        referencePrice: 120,
        agreementName: 'Seguros Ávila',
        agreementPayerName: 'Seguros Ávila',
        listPriceCurrency: 'USD',
      }),
      item(C, { price: 80.25 }),
    ];
    const totals = splitTotals(
      items,
      { acceptedItemIds: [A, C], pendingItemIds: [B] },
      'USD',
    );
    expect(totals.accepted).toEqual({
      currency: 'USD',
      gross: 530.25,
      discount: 45.5,
      net: 484.75,
      agreementSaving: 0,
    });
    expect(totals.pending).toEqual({
      currency: 'USD',
      gross: 120,
      discount: 0,
      net: 120,
      agreementSaving: 30,
    });
    expect(totals.original.net).toBe(604.75);
  });

  // Moneda (VES y USD con céntimos, JPY sin decimales), precios y descuentos
  // con céntimos o enteros, convenio con lista en la moneda del plan o en
  // otra, y cualquier partición no vacía de los dos lados.
  const currencyArb = fc.constantFrom(
    { code: 'USD', integral: false },
    { code: 'VES', integral: false },
    { code: 'JPY', integral: true },
  );

  it('para cualquier plan y cualquier partición (propiedad)', () => {
    fc.assert(
      fc.property(
        currencyArb.chain((currency) =>
          fc.tuple(
            fc.constant(currency),
            fc.array(
              fc
                .record({
                  priceCents: fc.integer({ min: 0, max: 50_000_000 }),
                  discountShare: fc.double({ min: 0, max: 1, noNaN: true }),
                  agreement: fc.boolean(),
                  listCurrency: fc.constantFrom(currency.code, 'USD', 'EUR'),
                  listExtraCents: fc.integer({ min: 0, max: 1_000_000 }),
                  accepted: fc.boolean(),
                })
                .map((r) => {
                  const unit = currency.integral ? 100 : 1;
                  const priceCents = Math.floor(r.priceCents / unit) * unit;
                  const discountCents =
                    Math.floor((priceCents * r.discountShare) / unit) * unit;
                  return {
                    accepted: r.accepted,
                    item: item('id', {
                      price: priceCents / 100,
                      discount: discountCents / 100,
                      ...(r.agreement
                        ? {
                            agreementName: 'Convenio',
                            agreementPayerName: 'Pagador',
                            basePrice: (priceCents + r.listExtraCents) / 100,
                            referencePrice: priceCents / 100,
                            listPriceCurrency: r.listCurrency,
                          }
                        : {}),
                    }),
                  };
                }),
              { minLength: 2, maxLength: 40 },
            ),
          ),
        ),
        ([currency, generated]) => {
          // Ids distintos por posición.
          const rows = generated.map((r, i) => ({
            accepted: r.accepted,
            item: {
              ...r.item,
              id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
            },
          }));
          const acceptedItemIds = rows
            .filter((r) => r.accepted)
            .map((r) => r.item.id);
          const pendingItemIds = rows
            .filter((r) => !r.accepted)
            .map((r) => r.item.id);
          fc.pre(acceptedItemIds.length > 0 && pendingItemIds.length > 0);
          const items = rows.map((r) => r.item);
          const { accepted, pending, original } = splitTotals(
            items,
            { acceptedItemIds, pendingItemIds },
            currency.code,
          );
          for (const key of [
            'gross',
            'discount',
            'net',
            'agreementSaving',
          ] as const) {
            expect(toCents(accepted[key]) + toCents(pending[key])).toBe(
              toCents(original[key]),
            );
          }
          if (currency.integral) {
            expect(Number.isInteger(accepted.net)).toBe(true);
            expect(Number.isInteger(pending.net)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
