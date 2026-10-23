import {
  arqueo,
  centsOf,
  expectedLines,
  fromCents,
  methodBucket,
} from './arqueo';

describe('arqueo de caja (DX-027)', () => {
  it('pasa importes a céntimos exactos y de vuelta', () => {
    expect(centsOf(0.1 + 0.2)).toBe(30);
    expect(centsOf(150_000.55)).toBe(15_000_055);
    expect(fromCents(15_000_055)).toBe(150_000.55);
  });

  it('un abono sin método cuenta como «Otro»', () => {
    expect(methodBucket(null)).toBe('OTHER');
    expect(methodBucket('CARD')).toBe('CARD');
  });

  it('esperado = fondo (solo efectivo) + abonos + ajustes, por moneda y método', () => {
    const lines = expectedLines({
      floats: [
        { currency: 'COP', cents: 5_000_000 },
        { currency: 'USD', cents: 0 },
      ],
      payments: [
        { currency: 'COP', method: 'CASH', cents: 2_000_000 },
        { currency: 'COP', method: 'CASH', cents: 1_000_000 },
        { currency: 'COP', method: 'CARD', cents: 8_000_000 },
        { currency: 'COP', method: null, cents: 100 },
        { currency: 'USD', method: 'TRANSFER', cents: 5_000 },
      ],
      adjustments: [{ currency: 'COP', method: 'CASH', cents: -500_000 }],
      outflows: [],
    });
    expect(lines).toEqual([
      {
        currency: 'COP',
        method: 'CASH',
        openingCents: 5_000_000,
        paymentsCents: 3_000_000,
        paymentsCount: 2,
        adjustmentsCents: -500_000,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 7_500_000,
      },
      {
        currency: 'COP',
        method: 'CARD',
        openingCents: 0,
        paymentsCents: 8_000_000,
        paymentsCount: 1,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 8_000_000,
      },
      {
        currency: 'COP',
        method: 'OTHER',
        openingCents: 0,
        paymentsCents: 100,
        paymentsCount: 1,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 100,
      },
      {
        currency: 'USD',
        method: 'CASH',
        openingCents: 0,
        paymentsCents: 0,
        paymentsCount: 0,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 0,
      },
      {
        currency: 'USD',
        method: 'TRANSFER',
        openingCents: 0,
        paymentsCents: 5_000,
        paymentsCount: 1,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 5_000,
      },
    ]);
  });

  it('diferencia = contado − esperado; lo no contado es 0 y lo contado sin esperado también entra', () => {
    const expected = expectedLines({
      floats: [{ currency: 'COP', cents: 1_000 }],
      payments: [{ currency: 'COP', method: 'CARD', cents: 500 }],
      adjustments: [],
      outflows: [],
    });
    const result = arqueo(expected, [
      { currency: 'COP', method: 'CASH', cents: 900 },
      { currency: 'USD', method: 'CASH', cents: 0 },
    ]);
    expect(result).toEqual({
      hasDifference: true,
      lines: [
        expect.objectContaining({
          currency: 'COP',
          method: 'CASH',
          expectedCents: 1_000,
          countedCents: 900,
          differenceCents: -100,
        }),
        expect.objectContaining({
          currency: 'COP',
          method: 'CARD',
          expectedCents: 500,
          countedCents: 0,
          differenceCents: -500,
        }),
        expect.objectContaining({
          currency: 'USD',
          method: 'CASH',
          expectedCents: 0,
          countedCents: 0,
          differenceCents: 0,
        }),
      ],
    });
  });

  it('cuadrado: sin diferencia', () => {
    const expected = expectedLines({
      floats: [{ currency: 'COP', cents: 1_000 }],
      payments: [{ currency: 'COP', method: 'CASH', cents: 500 }],
      adjustments: [],
      outflows: [],
    });
    expect(
      arqueo(expected, [{ currency: 'COP', method: 'CASH', cents: 1_500 }])
        .hasDifference,
    ).toBe(false);
  });

  it('las salidas de caja (DX-274) restan del efectivo de su moneda, aunque quede negativo', () => {
    const lines = expectedLines({
      floats: [{ currency: 'COP', cents: 1_000_000 }],
      payments: [
        { currency: 'COP', method: 'CASH', cents: 200_000 },
        { currency: 'COP', method: 'CARD', cents: 300_000 },
      ],
      adjustments: [{ currency: 'COP', method: 'CASH', cents: 50_000 }],
      outflows: [
        { currency: 'COP', cents: 150_000 },
        { currency: 'COP', cents: 25_000 },
        { currency: 'USD', cents: 1_000 },
      ],
    });
    expect(lines).toEqual([
      {
        currency: 'COP',
        method: 'CASH',
        openingCents: 1_000_000,
        paymentsCents: 200_000,
        paymentsCount: 1,
        adjustmentsCents: 50_000,
        outflowsCents: 175_000,
        outflowsCount: 2,
        expectedCents: 1_075_000,
      },
      expect.objectContaining({
        currency: 'COP',
        method: 'CARD',
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 300_000,
      }),
      {
        currency: 'USD',
        method: 'CASH',
        openingCents: 0,
        paymentsCents: 0,
        paymentsCount: 0,
        adjustmentsCents: 0,
        outflowsCents: 1_000,
        outflowsCount: 1,
        expectedCents: -1_000,
      },
    ]);
  });

  it('una caja que cuadra con salidas: contado = esperado tras restarlas', () => {
    const expected = expectedLines({
      floats: [{ currency: 'COP', cents: 100_000 }],
      payments: [],
      adjustments: [],
      outflows: [{ currency: 'COP', cents: 30_000 }],
    });
    const result = arqueo(expected, [
      { currency: 'COP', method: 'CASH', cents: 70_000 },
    ]);
    expect(result.hasDifference).toBe(false);
    expect(result.lines[0]).toMatchObject({
      expectedCents: 70_000,
      countedCents: 70_000,
      differenceCents: 0,
    });
  });

  it('un par (moneda, método) contado dos veces es un error del cliente', () => {
    expect(() =>
      arqueo(
        [],
        [
          { currency: 'COP', method: 'CASH', cents: 1 },
          { currency: 'COP', method: 'CASH', cents: 2 },
        ],
      ),
    ).toThrow(RangeError);
  });
});
