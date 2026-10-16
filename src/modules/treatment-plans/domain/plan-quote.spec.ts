import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
  QUOTE_VALIDITY_DAYS,
  type QuoteContentSource,
} from './plan-quote';

function source(
  overrides: Partial<QuoteContentSource> = {},
): QuoteContentSource {
  return {
    planId: 'plan-1',
    patientId: 'patient-1',
    currency: 'COP',
    clinicName: 'Clínica Sonrisa',
    location: { id: 'loc-1', name: 'Sede principal', address: 'Calle 1 # 2-3' },
    patient: { name: 'Ana Pérez', document: 'CC 123' },
    professionalName: 'Dra. Gómez',
    items: [
      {
        id: 'i1',
        toothNumber: '36',
        surfaces: [],
        procedure: 'Implante',
        price: 3500000,
        discount: 350000,
      },
      {
        id: 'i2',
        toothNumber: '16',
        surfaces: ['OCCLUSAL', 'MESIAL'],
        procedure: 'Resina',
        price: 180000.5,
        discount: 0,
      },
    ],
    ...overrides,
  };
}

describe('buildQuoteContent (DX-012)', () => {
  it('calcula subtotales, totales por moneda y la validez de 30 días', () => {
    const content = buildQuoteContent(source(), '2026-10-16');

    expect(QUOTE_VALIDITY_DAYS).toBe(30);
    expect(content.issuedOn).toBe('2026-10-16');
    expect(content.validUntil).toBe('2026-11-15');
    expect(content.validityDays).toBe(30);
    expect(content.items).toEqual([
      expect.objectContaining({
        id: 'i1',
        quantity: 1,
        unitPrice: 3500000,
        discount: 350000,
        subtotal: 3150000,
      }),
      expect.objectContaining({
        id: 'i2',
        surfaces: ['OCCLUSAL', 'MESIAL'],
        quantity: 1,
        unitPrice: 180000.5,
        discount: 0,
        subtotal: 180000.5,
      }),
    ]);
    expect(content.totals).toEqual([
      { currency: 'COP', gross: 3680000.5, discount: 350000, net: 3330000.5 },
    ]);
  });

  it('un plan sin ítems da totales en cero (no una lista vacía)', () => {
    const content = buildQuoteContent(source({ items: [] }), '2026-12-20');
    expect(content.items).toEqual([]);
    expect(content.totals).toEqual([
      { currency: 'COP', gross: 0, discount: 0, net: 0 },
    ]);
    expect(content.validUntil).toBe('2027-01-19');
  });

  it('suma en céntimos: sin deriva de coma flotante', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      toothNumber: '11',
      surfaces: [],
      procedure: 'P',
      price: 0.1,
      discount: 0,
    }));
    const content = buildQuoteContent(source({ items }), '2026-10-16');
    expect(content.totals[0].net).toBe(1);
  });
});

describe('computeQuoteHash', () => {
  const base = buildQuoteContent(source(), '2026-10-16');

  it('es un SHA-256 hex estable para el mismo contenido', () => {
    const hash = computeQuoteHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeQuoteHash(buildQuoteContent(source(), '2026-10-16'))).toBe(
      hash,
    );
  });

  it('cambia si cambia un precio, un descuento, un diente, la fecha o el paciente', () => {
    const hash = computeQuoteHash(base);
    const variants = [
      source({
        items: [{ ...source().items[0], price: 3500001 }, source().items[1]],
      }),
      source({
        items: [{ ...source().items[0], discount: 1 }, source().items[1]],
      }),
      source({
        items: [{ ...source().items[0], toothNumber: '37' }, source().items[1]],
      }),
      source({ patient: { name: 'Ana Pérez', document: 'CC 124' } }),
      source({ currency: 'USD' }),
    ];
    for (const variant of variants) {
      expect(
        computeQuoteHash(buildQuoteContent(variant, '2026-10-16')),
      ).not.toBe(hash);
    }
    expect(
      computeQuoteHash(buildQuoteContent(source(), '2026-10-17')),
    ).not.toBe(hash);
  });

  it('sobrevive a un viaje por JSON (lo que guarda la base en JSONB)', () => {
    const roundTrip = parseQuoteContent(JSON.parse(JSON.stringify(base)));
    expect(computeQuoteHash(roundTrip)).toBe(computeQuoteHash(base));
  });
});

describe('computeAcceptanceHash', () => {
  const at = new Date('2026-10-16T15:00:00.000Z');

  it('sella contenido, firmante, firma y hora', () => {
    const hash = computeAcceptanceHash({
      contentHash: 'a'.repeat(64),
      signerName: 'Ana Pérez',
      signature: 'iVBOR',
      acceptedAt: at,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { contentHash: 'b'.repeat(64) },
      { signerName: 'Ana Perez' },
      { signature: 'iVBOS' },
      { acceptedAt: new Date('2026-10-16T15:00:00.001Z') },
    ]) {
      expect(
        computeAcceptanceHash({
          contentHash: 'a'.repeat(64),
          signerName: 'Ana Pérez',
          signature: 'iVBOR',
          acceptedAt: at,
          ...change,
        }),
      ).not.toBe(hash);
    }
  });
});

describe('parseQuoteContent', () => {
  it('rechaza un JSON que no es un presupuesto', () => {
    expect(() => parseQuoteContent({ version: 1 })).toThrow(
      /presupuesto guardado/,
    );
    expect(() => parseQuoteContent(null)).toThrow(/presupuesto guardado/);
    expect(() => parseQuoteContent([])).toThrow(/presupuesto guardado/);
  });
});
