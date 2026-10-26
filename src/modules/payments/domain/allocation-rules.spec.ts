import { TreatmentPlanItemStatus } from '@prisma/client';
import {
  allocationVersion,
  hasFixedPointViolation,
  itemBillableCents,
  orderDonors,
  orderItems,
  respreadSurplus,
  validateManualAllocation,
  type AllocatableItem,
  type Donor,
} from './allocation-rules';

const d = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);

const item = (
  over: Partial<AllocatableItem> & { id: string },
): AllocatableItem => ({
  status: 'ACCEPTED',
  createdAt: d(1),
  completedAt: null,
  billableCents: 0,
  allocatedCents: 0,
  ...over,
});

const donor = (over: Partial<Donor> & { paymentId: string }): Donor => ({
  paidAt: d(1),
  createdAt: d(1),
  baseCents: 0,
  allocatedCents: 0,
  ...over,
});

function apply(
  donors: Donor[],
  items: AllocatableItem[],
  inc: { paymentId: string; itemId: string; cents: number }[],
) {
  return {
    donors: donors.map((x) => ({
      ...x,
      allocatedCents:
        x.allocatedCents +
        inc
          .filter((i) => i.paymentId === x.paymentId)
          .reduce((s, i) => s + i.cents, 0),
    })),
    items: items.map((x) => ({
      ...x,
      allocatedCents:
        x.allocatedCents +
        inc.filter((i) => i.itemId === x.id).reduce((s, i) => s + i.cents, 0),
    })),
  };
}

describe('orderItems', () => {
  it('puts DONE by completedAt before ACCEPTED by createdAt', () => {
    const out = orderItems([
      item({ id: 'a1', status: 'ACCEPTED', createdAt: d(1) }),
      item({ id: 'd2', status: 'DONE', createdAt: d(1), completedAt: d(9) }),
      item({ id: 'd1', status: 'DONE', createdAt: d(5), completedAt: d(3) }),
      item({ id: 'a0', status: 'ACCEPTED', createdAt: d(2) }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['d1', 'd2', 'a1', 'a0']);
  });

  it('DONE without completedAt falls back to createdAt', () => {
    const out = orderItems([
      item({ id: 'x', status: 'DONE', createdAt: d(8), completedAt: d(9) }),
      item({ id: 'y', status: 'DONE', createdAt: d(2), completedAt: null }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['y', 'x']);
  });

  it('ties break by id', () => {
    const out = orderItems([item({ id: 'b' }), item({ id: 'a' })]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('orderDonors', () => {
  it('orders by paidAt, createdAt, then id', () => {
    const out = orderDonors([
      donor({ paymentId: 'c', paidAt: d(2) }),
      donor({ paymentId: 'b', paidAt: d(1), createdAt: d(3) }),
      donor({ paymentId: 'a', paidAt: d(1), createdAt: d(3) }),
      donor({ paymentId: 'z', paidAt: d(1), createdAt: d(2) }),
    ]);
    expect(out.map((x) => x.paymentId)).toEqual(['z', 'a', 'b', 'c']);
  });
});

describe('respreadSurplus', () => {
  it('serves the oldest payment first', () => {
    const donors = [
      donor({ paymentId: 'P2', paidAt: d(2), baseCents: 50 }),
      donor({ paymentId: 'P1', paidAt: d(1), baseCents: 30 }),
    ];
    const items = [item({ id: 'I', billableCents: 60 })];
    expect(respreadSurplus(donors, items)).toEqual([
      { paymentId: 'P1', itemId: 'I', cents: 30 },
      { paymentId: 'P2', itemId: 'I', cents: 30 },
    ]);
  });

  it('never exceeds item free balance nor payment surplus', () => {
    const donors = [
      donor({ paymentId: 'P1', baseCents: 100, allocatedCents: 40 }),
      donor({ paymentId: 'P2', paidAt: d(2), baseCents: 25 }),
    ];
    const items = [
      item({ id: 'A', billableCents: 50, allocatedCents: 20 }),
      item({ id: 'B', createdAt: d(2), billableCents: 40 }),
    ];
    const inc = respreadSurplus(donors, items);
    for (const x of donors) {
      const used = inc
        .filter((i) => i.paymentId === x.paymentId)
        .reduce((s, i) => s + i.cents, 0);
      expect(used).toBeLessThanOrEqual(x.baseCents - x.allocatedCents);
    }
    for (const x of items) {
      const used = inc
        .filter((i) => i.itemId === x.id)
        .reduce((s, i) => s + i.cents, 0);
      expect(used).toBeLessThanOrEqual(x.billableCents - x.allocatedCents);
    }
    expect(inc.reduce((s, i) => s + i.cents, 0)).toBe(70);
  });

  it('is idempotent', () => {
    const donors = [donor({ paymentId: 'P1', baseCents: 80 })];
    const items = [
      item({ id: 'A', billableCents: 50 }),
      item({ id: 'B', createdAt: d(2), billableCents: 50 }),
    ];
    const next = apply(donors, items, respreadSurplus(donors, items));
    expect(respreadSurplus(next.donors, next.items)).toEqual([]);
  });

  it('leaves no fixed-point violation', () => {
    const donors = [
      donor({ paymentId: 'P1', baseCents: 70 }),
      donor({ paymentId: 'P2', paidAt: d(2), baseCents: 70 }),
    ];
    const items = [
      item({ id: 'A', billableCents: 90 }),
      item({ id: 'B', createdAt: d(2), billableCents: 30 }),
    ];
    expect(hasFixedPointViolation(donors, items)).toBe(true);
    const next = apply(donors, items, respreadSurplus(donors, items));
    expect(hasFixedPointViolation(next.donors, next.items)).toBe(false);
  });

  it('exact fill: surplus equal to free leaves the next item untouched', () => {
    const donors = [donor({ paymentId: 'P1', baseCents: 50 })];
    const items = [
      item({ id: 'A', billableCents: 50 }),
      item({ id: 'B', createdAt: d(2), billableCents: 40 }),
    ];
    expect(respreadSurplus(donors, items)).toEqual([
      { paymentId: 'P1', itemId: 'A', cents: 50 },
    ]);
  });

  it('skips a full item and fills the next one', () => {
    const donors = [donor({ paymentId: 'P1', baseCents: 30 })];
    const items = [
      item({ id: 'A', billableCents: 50, allocatedCents: 50 }),
      item({ id: 'B', createdAt: d(2), billableCents: 40 }),
    ];
    expect(respreadSurplus(donors, items)).toEqual([
      { paymentId: 'P1', itemId: 'B', cents: 30 },
    ]);
  });

  it('donors tied on paidAt and createdAt are served by id', () => {
    const donors = [
      donor({ paymentId: 'b', baseCents: 10 }),
      donor({ paymentId: 'a', baseCents: 10 }),
    ];
    expect(
      respreadSurplus(donors, [item({ id: 'I', billableCents: 10 })]),
    ).toEqual([{ paymentId: 'a', itemId: 'I', cents: 10 }]);
  });

  it('is idempotent with several donors and items', () => {
    const donors = [
      donor({ paymentId: 'P1', baseCents: 70 }),
      donor({
        paymentId: 'P2',
        paidAt: d(2),
        baseCents: 45,
        allocatedCents: 5,
      }),
    ];
    const items = [
      item({ id: 'A', billableCents: 60 }),
      item({ id: 'B', createdAt: d(2), billableCents: 30, allocatedCents: 5 }),
      item({ id: 'C', status: 'DONE', completedAt: d(3), billableCents: 25 }),
    ];
    const first = respreadSurplus(donors, items);
    expect(first.length).toBeGreaterThan(0);
    const next = apply(donors, items, first);
    expect(respreadSurplus(next.donors, next.items)).toEqual([]);
  });

  it('with no surplus returns []', () => {
    const donors = [
      donor({ paymentId: 'P1', baseCents: 50, allocatedCents: 50 }),
    ];
    expect(
      respreadSurplus(donors, [item({ id: 'A', billableCents: 90 })]),
    ).toEqual([]);
  });
});

describe('validateManualAllocation', () => {
  const items = new Map<
    string,
    { status: TreatmentPlanItemStatus | 'MISSING'; freeCents: number }
  >([
    ['A', { status: 'ACCEPTED', freeCents: 100 }],
    ['B', { status: 'DONE', freeCents: 50 }],
    ['P', { status: 'PROPOSED', freeCents: 0 }],
    ['M', { status: 'MISSING', freeCents: 0 }],
  ]);
  const run = (
    lines: { itemId: string; cents: number }[],
    baseCents: number | null = 120,
  ) => validateManualAllocation({ baseCents, lines, items });

  it('accepts a valid list and an empty one', () => {
    expect(
      run([
        { itemId: 'A', cents: 100 },
        { itemId: 'B', cents: 20 },
      ]),
    ).toBeNull();
    expect(run([])).toBeNull();
  });
  it('NO_RATE without base', () => {
    expect(run([], null)).toEqual({ code: 'NO_RATE' });
  });
  it('DUPLICATE', () => {
    expect(
      run([
        { itemId: 'A', cents: 1 },
        { itemId: 'A', cents: 1 },
      ]),
    ).toEqual({ code: 'DUPLICATE' });
  });
  it('TOO_MANY', () => {
    const lines = Array.from({ length: 201 }, (_, i) => ({
      itemId: `i${i}`,
      cents: 1,
    }));
    expect(run(lines)).toEqual({ code: 'TOO_MANY' });
  });
  it('NOT_IN_PLAN for unknown and missing items', () => {
    expect(run([{ itemId: 'zzz', cents: 1 }])).toEqual({ code: 'NOT_IN_PLAN' });
    expect(run([{ itemId: 'M', cents: 1 }])).toEqual({ code: 'NOT_IN_PLAN' });
  });
  it('PROPOSED', () => {
    expect(run([{ itemId: 'P', cents: 1 }])).toEqual({ code: 'PROPOSED' });
  });
  it('OVER_ITEM carries the free balance', () => {
    expect(run([{ itemId: 'B', cents: 51 }])).toEqual({
      code: 'OVER_ITEM',
      freeCents: 50,
    });
  });
  it('OVER_PAYMENT carries the sum', () => {
    expect(
      run([
        { itemId: 'A', cents: 100 },
        { itemId: 'B', cents: 21 },
      ]),
    ).toEqual({
      code: 'OVER_PAYMENT',
      sumCents: 121,
    });
  });
});

describe('allocationVersion', () => {
  const lines = [
    { itemId: 'a', cents: 10 },
    { itemId: 'b', cents: 20 },
  ];
  it('is order independent', () => {
    expect(allocationVersion({ manual: true, lines })).toBe(
      allocationVersion({ manual: true, lines: [...lines].reverse() }),
    );
  });
  it('changes with any cent and with manual', () => {
    const base = allocationVersion({ manual: true, lines });
    expect(
      allocationVersion({
        manual: true,
        lines: [lines[0], { itemId: 'b', cents: 21 }],
      }),
    ).not.toBe(base);
    expect(allocationVersion({ manual: false, lines })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('itemBillableCents', () => {
  const base = {
    status: TreatmentPlanItemStatus.ACCEPTED,
    price: 100.1,
    discount: 0.05,
    deletedAt: null,
  };
  it('rounds (price - discount) to cents', () => {
    expect(itemBillableCents(base, true)).toBe(10005);
  });
  it('is 0 for PROPOSED, deleted items or a non-billable plan', () => {
    expect(
      itemBillableCents(
        { ...base, status: TreatmentPlanItemStatus.PROPOSED },
        true,
      ),
    ).toBe(0);
    expect(itemBillableCents({ ...base, deletedAt: d(1) }, true)).toBe(0);
    expect(itemBillableCents(base, false)).toBe(0);
  });
});
