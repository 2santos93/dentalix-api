import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  DiscountReason,
  ExchangeRateSource,
  PriceSource,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { DEFAULT_DISCOUNT_POLICY } from '../../discounts/domain/discount-policy';
import type { FrozenReferenceRate } from '../../discounts/domain/reference-in-plan';
import type { TreatmentPlanItem } from '../domain/entities/treatment-plan-item.entity';
import {
  REPRICE_CREDIT_MESSAGE,
  REPRICE_ITEM_NOT_PROPOSED_MESSAGE,
  REPRICE_PAYMENTS_MESSAGE,
  REPRICE_PAYMENT_PLAN_MESSAGE,
  REPRICE_SIGNED_MESSAGE,
  assertPlanRepriceable,
  computeRepricing,
  repricingCatalogItemIds,
  type RepricingInput,
  type RepricingReference,
} from './repricing';
import {
  ADMIN_ACTOR,
  ASSISTANT_ACTOR,
  DENTIST_ACTOR,
} from './use-cases/__fixtures__/discount-fixtures';
import { FEE_ITEM_LOCKED_MESSAGE } from '../../cancellation-fees/domain/cancellation-fee';

const AT = new Date('2026-11-09T15:00:00.000Z');
const VALIDITY = { issuedOn: '2026-11-09', validUntil: '2026-12-09' };
const LOC = 'loc-1';

const RATE_36: FrozenReferenceRate = {
  fromPerBase: 1,
  toPerBase: 36,
  source: ExchangeRateSource.MANUAL,
  rateDate: '2026-10-01',
};
const RATE_40: FrozenReferenceRate = {
  fromPerBase: 1,
  toPerBase: 40,
  source: ExchangeRateSource.MANUAL,
  rateDate: '2026-11-09',
};

let seq = 0;
function item(overrides: Partial<TreatmentPlanItem> = {}): TreatmentPlanItem {
  seq += 1;
  return {
    id: `item-${String(seq).padStart(3, '0')}`,
    tenantId: 't1',
    planId: 'plan-1',
    toothNumber: '11',
    surfaces: [],
    catalogItemId: 'endo',
    catalogPrice: 100,
    basePrice: 100,
    catalogCurrency: 'USD',
    priceSource: PriceSource.CATALOG,
    referenceCurrency: 'USD',
    referencePriceInPlan: 100,
    basePriceInPlan: 100,
    referenceRate: null,
    baseRate: null,
    agreementId: null,
    agreementName: null,
    pricingLocationId: LOC,
    price: 100,
    discount: 0,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
    status: TreatmentPlanItemStatus.PROPOSED,
    performedById: null,
    performedByName: null,
    performedLocationId: null,
    performedLocationName: null,
    completedAt: null,
    cancellationFeeAppointmentId: null,
    notes: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** Precio vigente en la moneda del plan, del catálogo y sin conversión. */
function catalogRef(
  price: number,
  overrides: Partial<Extract<RepricingReference, { kind: 'priced' }>> = {},
): RepricingReference {
  return {
    kind: 'priced',
    resolved: {
      price,
      basePrice: price,
      source: PriceSource.CATALOG,
      agreementId: null,
      agreementName: null,
      allowDiscount: true,
    },
    catalogCurrency: 'USD',
    pricingLocationId: LOC,
    reference: {
      referenceCurrency: 'USD',
      referencePriceInPlan: price,
      basePriceInPlan: price,
      referenceRate: null,
    },
    ...overrides,
  };
}

function input(
  items: TreatmentPlanItem[],
  references: Record<string, RepricingReference>,
  overrides: Partial<RepricingInput> = {},
): RepricingInput {
  return {
    plan: {
      id: 'plan-1',
      currency: 'USD',
      items,
      quoteIssuedOn: '2026-09-01',
      quoteValidUntil: '2026-10-01',
    },
    references: new Map(Object.entries(references)),
    digits: 2,
    policy: DEFAULT_DISCOUNT_POLICY,
    actor: DENTIST_ACTOR,
    at: AT,
    validity: VALIDITY,
    ...overrides,
  };
}

describe('computeRepricing (DX-379 porción B)', () => {
  it('plan en VES con el catálogo en USD: reconvierte con la tasa de hoy y guarda la foto nueva', () => {
    const old = item({
      catalogPrice: 100,
      basePrice: 100,
      catalogCurrency: 'USD',
      referenceCurrency: 'USD',
      referencePriceInPlan: 3600,
      basePriceInPlan: 3600,
      referenceRate: RATE_36,
      price: 3600,
    });
    const r = computeRepricing(
      input(
        [old],
        {
          endo: catalogRef(100, {
            reference: {
              referenceCurrency: 'USD',
              referencePriceInPlan: 4000,
              basePriceInPlan: 4000,
              referenceRate: RATE_40,
            },
          }),
        },
        {
          plan: {
            id: 'plan-1',
            currency: 'VES',
            items: [old],
            quoteIssuedOn: null,
            quoteValidUntil: null,
          },
        },
      ),
    );
    expect(r.skipped).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].after).toMatchObject({
      price: 4000,
      discount: 0,
      catalogPrice: 100,
      catalogCurrency: 'USD',
      reference: { referencePriceInPlan: 4000, referenceRate: RATE_40 },
    });
    expect(r.lines[0].changed).toBe(true);
    expect(r.rate).toEqual({ currency: 'USD', ...RATE_40 });
    expect(r.totals).toEqual({ before: 3600, after: 4000 });
    expect(r.previousValidity).toBeNull();
    expect(r.validity).toEqual(VALIDITY);
    expect(r.previewHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sin tasa de hoy el ítem no se toca y se señala con la moneda', () => {
    const a = item();
    const r = computeRepricing(
      input([a], { endo: { kind: 'no-rate', currency: 'USD' } }),
    );
    expect(r.lines).toEqual([]);
    expect(r.skipped).toEqual([
      expect.objectContaining({
        itemId: a.id,
        reason: 'NO_RATE',
        currency: 'USD',
      }),
    ]);
    expect(r.totals).toEqual({ before: 100, after: 100 });
  });

  it('sin precio vigente, con precio 0 o sin procedimiento: «sin precio vigente», nunca a 0 (D-10)', () => {
    const a = item({ catalogItemId: 'a' });
    const b = item({ catalogItemId: 'b' });
    const c = item({ catalogItemId: 'c' });
    const r = computeRepricing(
      input([a, b, c], {
        a: { kind: 'no-price' },
        b: catalogRef(0),
        // c: el procedimiento ya no existe (sin referencia en el mapa).
      }),
    );
    expect(r.lines).toEqual([]);
    expect(r.skipped.map((s) => [s.itemId, s.reason])).toEqual([
      [a.id, 'NO_CURRENT_PRICE'],
      [b.id, 'NO_CURRENT_PRICE'],
      [c.id, 'NO_CURRENT_PRICE'],
    ]);
  });

  it('convenio %: el precio nuevo es el % sobre el catálogo de hoy, con su convenio', () => {
    const old = item({
      catalogPrice: 85,
      basePrice: 100,
      priceSource: PriceSource.AGREEMENT_PERCENT,
      agreementId: 'agr-1',
      agreementName: 'Seguro Caracas',
      referencePriceInPlan: 85,
      basePriceInPlan: 100,
      price: 85,
    });
    const r = computeRepricing(
      input([old], {
        endo: {
          kind: 'priced',
          resolved: {
            price: 102,
            basePrice: 120,
            source: PriceSource.AGREEMENT_PERCENT,
            agreementId: 'agr-1',
            agreementName: 'Seguro Caracas',
            allowDiscount: true,
          },
          catalogCurrency: 'USD',
          pricingLocationId: LOC,
          reference: {
            referenceCurrency: 'USD',
            referencePriceInPlan: 102,
            basePriceInPlan: 120,
            referenceRate: null,
          },
        },
      }),
    );
    expect(r.lines[0].after).toMatchObject({
      price: 102,
      discount: 0,
      catalogPrice: 102,
      basePrice: 120,
      priceSource: PriceSource.AGREEMENT_PERCENT,
      agreementName: 'Seguro Caracas',
    });
  });

  it('lista de convenio y lista de la sede: el precio vigente de la lista', () => {
    const a = item({ catalogItemId: 'a', priceSource: PriceSource.PRICE_LIST });
    const b = item({
      catalogItemId: 'b',
      priceSource: PriceSource.AGREEMENT_PRICE_LIST,
    });
    const list = (price: number, source: PriceSource): RepricingReference => ({
      kind: 'priced',
      resolved: {
        price,
        basePrice: 100,
        source,
        agreementId: source === PriceSource.PRICE_LIST ? null : 'agr-1',
        agreementName: source === PriceSource.PRICE_LIST ? null : 'Pacto',
        allowDiscount: true,
      },
      catalogCurrency: 'USD',
      pricingLocationId: LOC,
      reference: {
        referenceCurrency: 'USD',
        referencePriceInPlan: price,
        basePriceInPlan: 100,
        referenceRate: null,
      },
    });
    const r = computeRepricing(
      input([a, b], {
        a: list(130, PriceSource.PRICE_LIST),
        b: list(110, PriceSource.AGREEMENT_PRICE_LIST),
      }),
    );
    expect(r.lines.map((l) => [l.after.priceSource, l.after.price])).toEqual([
      [PriceSource.PRICE_LIST, 130],
      [PriceSource.AGREEMENT_PRICE_LIST, 110],
    ]);
    expect(r.totals).toEqual({ before: 200, after: 240 });
  });

  it('rebaja manual: conserva la proporción precio / referencia (D-4) y la firma de quien la dio', () => {
    const old = item({
      price: 90,
      discountReason: DiscountReason.LOYALTY,
      discountById: 'dentist-9',
      discountAt: new Date('2026-10-01T10:00:00.000Z'),
      discountLocationId: LOC,
    });
    const r = computeRepricing(input([old], { endo: catalogRef(150) }));
    expect(r.lines[0].after).toMatchObject({
      price: 135,
      discount: 0,
      discountReason: DiscountReason.LOYALTY,
      discountById: 'dentist-9',
      discountAt: '2026-10-01T10:00:00.000Z',
      discountLocationId: LOC,
    });
    expect(r.lines[0].discountDecision).toBeUndefined();
  });

  it('el descuento conserva su proporción sobre el precio', () => {
    const old = item({ price: 200, discount: 20 });
    const r = computeRepricing(
      input([old], { endo: catalogRef(150) }, { actor: ADMIN_ACTOR }),
    );
    // 150 × 200/100 = 300; 20/200 × 300 = 30.
    expect(r.lines[0].after).toMatchObject({ price: 300, discount: 30 });
    expect(r.totals).toEqual({ before: 180, after: 270 });
  });

  it('allowDiscount=false: el precio es el vigente y el descuento sigue en 0', () => {
    const old = item({ price: 120 });
    const r = computeRepricing(
      input([old], {
        endo: catalogRef(130, {
          resolved: {
            price: 130,
            basePrice: 130,
            source: PriceSource.CATALOG,
            agreementId: null,
            agreementName: null,
            allowDiscount: false,
          },
        }),
      }),
    );
    expect(r.lines[0].after).toMatchObject({ price: 130, discount: 0 });
  });

  it('sin referencia previa (ítem libre): el precio nuevo es el vigente', () => {
    const old = item({
      catalogPrice: null,
      basePrice: null,
      catalogCurrency: null,
      priceSource: null,
      referenceCurrency: null,
      referencePriceInPlan: null,
      basePriceInPlan: null,
      price: 77,
    });
    const r = computeRepricing(input([old], { endo: catalogRef(140) }));
    expect(r.lines[0].after.price).toBe(140);
  });

  it('moneda sin decimales: redondea a la unidad una sola vez; con rebaja, el precio sube a la unidad (M-4)', () => {
    const old = item({
      catalogPrice: 1000,
      basePrice: 1000,
      catalogCurrency: 'JPY',
      referenceCurrency: 'JPY',
      referencePriceInPlan: 1000,
      basePriceInPlan: 1000,
      price: 999,
      discount: 333,
    });
    const r = computeRepricing(
      input(
        [old],
        {
          endo: catalogRef(1501, {
            catalogCurrency: 'JPY',
            reference: {
              referenceCurrency: 'JPY',
              referencePriceInPlan: 1501,
              basePriceInPlan: 1501,
              referenceRate: null,
            },
          }),
        },
        {
          digits: 0,
          actor: ADMIN_ACTOR,
          plan: {
            id: 'plan-1',
            currency: 'JPY',
            items: [old],
            quoteIssuedOn: null,
            quoteValidUntil: null,
          },
        },
      ),
    );
    // 1501 × 999/1000 = 1499,499: hay rebaja (999 < 1000) → sube a 1500;
    // 333/999 × 1500 = 500 exacto.
    expect(r.lines[0].after).toMatchObject({ price: 1500, discount: 500 });
  });

  it('si el redondeo del descuento sube el %, baja a la unidad que no lo sube y conserva la firma', () => {
    const old = item({
      price: 100,
      discount: 1,
      discountReason: DiscountReason.LOYALTY,
      discountById: 'dentist-9',
      discountAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const r = computeRepricing(
      input([old], { endo: catalogRef(150.5) }, { actor: ASSISTANT_ACTOR }),
    );
    // 1/100 × 150,50 = 1,505 → 1,51 subiría el % → 1,50.
    expect(r.lines[0].after).toMatchObject({
      price: 150.5,
      discount: 1.5,
      discountById: 'dentist-9',
    });
    expect(r.lines[0].discountDecision).toBeUndefined();
  });

  it('M-4: con rebaja manual el redondeo nunca sube el %: la asistente recotiza sin 403 y la firma se conserva', () => {
    // Referencia 3, precio 2 (rebaja 33,33 %); referencia nueva 5 → 3,333…:
    // con la mitad hacia arriba 3,33 (rebaja 33,40 %, subía y daba 403 a la
    // asistente); hacia arriba 3,34 (rebaja 33,20 %): no sube.
    const old = item({
      catalogPrice: 3,
      basePrice: 3,
      referencePriceInPlan: 3,
      basePriceInPlan: 3,
      price: 2,
      discountReason: DiscountReason.LOYALTY,
      discountById: 'admin-9',
      discountAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const r = computeRepricing(
      input([old], { endo: catalogRef(5) }, { actor: ASSISTANT_ACTOR }),
    );
    expect(r.lines[0].after).toMatchObject({
      price: 3.34,
      discountReason: DiscountReason.LOYALTY,
      discountById: 'admin-9',
    });
    expect(r.lines[0].discountDecision).toBeUndefined();
  });

  it('sin rebaja, el precio sigue la mitad hacia arriba (regla de línea)', () => {
    // Precio 4 sobre referencia 3 (por encima); nueva 5 → 6,666… → 6,67.
    const old = item({
      catalogPrice: 3,
      basePrice: 3,
      referencePriceInPlan: 3,
      basePriceInPlan: 3,
      price: 4,
    });
    const r = computeRepricing(input([old], { endo: catalogRef(5) }));
    expect(r.lines[0].after.price).toBe(6.67);
  });

  it('si la mitad hacia arriba subiría el % del descuento, baja al suelo (aunque quede en 0)', () => {
    // Descuento 0,01 de 0,03 (33,3 %); referencia nueva 0,02: 0,00666… → 0,01
    // con la mitad hacia arriba (50 %, subiría); el suelo da 0.
    const old = item({
      catalogPrice: 0.03,
      basePrice: 0.03,
      referencePriceInPlan: 0.03,
      basePriceInPlan: 0.03,
      price: 0.03,
      discount: 0.01,
      discountReason: DiscountReason.LOYALTY,
    });
    const r = computeRepricing(
      input([old], { endo: catalogRef(0.02) }, { actor: ASSISTANT_ACTOR }),
    );
    expect(r.lines[0].after).toMatchObject({ price: 0.02, discount: 0 });
  });

  it('sin ítems pedidos: solo los propuestos; el resto y el cargo por inasistencia se listan', () => {
    const proposed = item();
    const accepted = item({ status: TreatmentPlanItemStatus.ACCEPTED });
    const done = item({ status: TreatmentPlanItemStatus.DONE });
    const fee = item({ cancellationFeeAppointmentId: 'appt-1' });
    const r = computeRepricing(
      input([proposed, accepted, done, fee], { endo: catalogRef(110) }),
    );
    expect(r.lines.map((l) => l.itemId)).toEqual([proposed.id]);
    expect(r.skipped.map((s) => [s.itemId, s.reason])).toEqual([
      [accepted.id, 'NOT_PROPOSED'],
      [done.id, 'NOT_PROPOSED'],
      [fee.id, 'CANCELLATION_FEE'],
    ]);
    expect(r.totals).toEqual({ before: 400, after: 410 });
  });

  it('ítems pedidos: solo esos; uno no propuesto o un cargo → 409; uno ajeno → 404', () => {
    const a = item();
    const b = item();
    const accepted = item({ status: TreatmentPlanItemStatus.ACCEPTED });
    const fee = item({ cancellationFeeAppointmentId: 'appt-1' });
    const all = [a, b, accepted, fee];
    const refs = { endo: catalogRef(110) };
    const r = computeRepricing(input(all, refs, { itemIds: [b.id, b.id] }));
    expect(r.lines.map((l) => l.itemId)).toEqual([b.id]);
    expect(r.skipped).toEqual([]);
    expect(() =>
      computeRepricing(input(all, refs, { itemIds: [a.id, accepted.id] })),
    ).toThrow(new ConflictException(REPRICE_ITEM_NOT_PROPOSED_MESSAGE));
    expect(() =>
      computeRepricing(input(all, refs, { itemIds: [fee.id] })),
    ).toThrow(new ConflictException(FEE_ITEM_LOCKED_MESSAGE));
    expect(() =>
      computeRepricing(input(all, refs, { itemIds: ['otro'] })),
    ).toThrow(NotFoundException);
    expect(repricingCatalogItemIds({ items: all })).toEqual(['endo']);
  });

  it('I-1: la validez solo se renueva si se recotizan TODOS los propuestos vivos', () => {
    const a = item({ catalogItemId: 'a' });
    const b = item({ catalogItemId: 'b' });
    const done = item({
      catalogItemId: 'a',
      status: TreatmentPlanItemStatus.DONE,
    });
    const fee = item({ catalogItemId: 'a', cancellationFeeAppointmentId: 'x' });
    const refs = { a: catalogRef(110), b: catalogRef(120) };
    const previous = { issuedOn: '2026-09-01', validUntil: '2026-10-01' };

    const all = computeRepricing(input([a, b, done, fee], refs));
    expect(all).toMatchObject({
      validityRenewed: true,
      validityNote: null,
      validity: VALIDITY,
    });

    const partial = computeRepricing(
      input([a, b, done, fee], refs, { itemIds: [a.id] }),
    );
    expect(partial).toMatchObject({
      validityRenewed: false,
      validityNote:
        'Quedan ítems con precios anteriores: la validez no se renueva.',
      validity: previous,
    });

    const noRate = computeRepricing(
      input([a, b], {
        a: catalogRef(110),
        b: { kind: 'no-rate', currency: 'USD' },
      }),
    );
    expect(noRate.validityRenewed).toBe(false);
    expect(noRate.validity).toEqual(previous);
    // Una selección que nombra a todos los propuestos sí renueva.
    expect(
      computeRepricing(input([a, b, done], refs, { itemIds: [b.id, a.id] }))
        .validityRenewed,
    ).toBe(true);
    // Un borrador sin fechas que no se renueva sigue sin validez.
    expect(
      computeRepricing(
        input([a, b], refs, {
          itemIds: [a.id],
          plan: {
            id: 'plan-1',
            currency: 'USD',
            items: [a, b],
            quoteIssuedOn: null,
            quoteValidUntil: null,
          },
        }),
      ).validity,
    ).toBeNull();
    // Renovar o no cambia la huella.
    expect(partial.previewHash).not.toBe(
      computeRepricing(input([a], refs, { itemIds: [a.id] })).previewHash,
    );
  });

  it('M-6: los ítems pedidos en mayúsculas se encuentran', () => {
    const a = item({ id: 'abcdef01-0000-4000-8000-000000000001' });
    const r = computeRepricing(
      input([a], { endo: catalogRef(110) }, { itemIds: [a.id.toUpperCase()] }),
    );
    expect(r.lines.map((l) => l.itemId)).toEqual([a.id]);
  });

  it('el mismo cálculo da la misma huella aunque cambie la hora; otra validez, otro precio u otra tasa la cambian', () => {
    const old = item({
      price: 2,
      catalogPrice: 3,
      referencePriceInPlan: 3,
      discountReason: DiscountReason.LOYALTY,
    });
    const base = input([old], { endo: catalogRef(5) }, { actor: ADMIN_ACTOR });
    const h = computeRepricing(base).previewHash;
    expect(
      computeRepricing({ ...base, at: new Date('2026-11-09T23:00:00.000Z') })
        .previewHash,
    ).toBe(h);
    expect(
      computeRepricing({
        ...base,
        validity: { issuedOn: '2026-11-10', validUntil: '2026-12-10' },
      }).previewHash,
    ).not.toBe(h);
    expect(
      computeRepricing({
        ...base,
        references: new Map([['endo', catalogRef(6)]]),
      }).previewHash,
    ).not.toBe(h);
    expect(
      computeRepricing({
        ...base,
        plan: { ...base.plan, items: [{ ...old, price: 2.5 }] },
      }).previewHash,
    ).not.toBe(h);
  });

  it('un ítem sin cambios sale como línea sin cambios (la validez se reinicia igual)', () => {
    const r = computeRepricing(input([item()], { endo: catalogRef(100) }));
    expect(r.lines[0].changed).toBe(false);
    expect(r.totals).toEqual({ before: 100, after: 100 });
  });
});

describe('assertPlanRepriceable (D-11)', () => {
  const none = {
    hasLivePayments: false,
    hasActivePaymentPlan: false,
    hasCreditEntries: false,
  };
  const open = { status: TreatmentPlanStatus.PRESENTED, acceptance: null };

  it('borrador y presentado sin cobros: se recotiza', () => {
    expect(() => assertPlanRepriceable(open, none)).not.toThrow();
    expect(() =>
      assertPlanRepriceable(
        { status: TreatmentPlanStatus.DRAFT, acceptance: null },
        none,
      ),
    ).not.toThrow();
  });

  it.each([
    TreatmentPlanStatus.ACCEPTED,
    TreatmentPlanStatus.COMPLETED,
    TreatmentPlanStatus.REJECTED,
    TreatmentPlanStatus.CANCELLED,
  ])('plan %s → 409', (status) => {
    expect(() =>
      assertPlanRepriceable({ status, acceptance: null }, none),
    ).toThrow(ConflictException);
  });

  it('firmado, con abonos, con plan de cuotas o con saldo a favor → 409 con su mensaje', () => {
    expect(() =>
      assertPlanRepriceable(
        {
          status: TreatmentPlanStatus.ACCEPTED,
          acceptance: {
            signerName: 'Ana',
            acceptedAt: AT,
            remote: null,
          },
        },
        none,
      ),
    ).toThrow(REPRICE_SIGNED_MESSAGE);
    expect(() =>
      assertPlanRepriceable(open, { ...none, hasLivePayments: true }),
    ).toThrow(REPRICE_PAYMENTS_MESSAGE);
    expect(() =>
      assertPlanRepriceable(open, { ...none, hasActivePaymentPlan: true }),
    ).toThrow(REPRICE_PAYMENT_PLAN_MESSAGE);
    expect(() =>
      assertPlanRepriceable(open, { ...none, hasCreditEntries: true }),
    ).toThrow(REPRICE_CREDIT_MESSAGE);
  });
});
