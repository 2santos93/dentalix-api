import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
  QUOTE_HASH_VERSION_V2,
  type QuoteContent,
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
    patient: { name: 'Ana Pérez', document: 'Documento nacional 123' },
    professionalName: 'Dra. Gómez',
    items: [
      {
        id: 'i1',
        toothNumber: '36',
        surfaces: [],
        procedure: 'Implante',
        price: 3500000,
        discount: 350000,
        basePrice: null,
        referencePrice: null,
        agreementName: null,
        agreementPayerName: null,
      },
      {
        id: 'i2',
        toothNumber: '16',
        surfaces: ['OCCLUSAL', 'MESIAL'],
        procedure: 'Resina',
        price: 180000.5,
        discount: 0,
        basePrice: null,
        referencePrice: null,
        agreementName: null,
        agreementPayerName: null,
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
      {
        currency: 'COP',
        gross: 3680000.5,
        discount: 350000,
        net: 3330000.5,
        agreementSaving: 0,
      },
    ]);
  });

  it('un plan sin ítems da totales en cero (no una lista vacía)', () => {
    const content = buildQuoteContent(source({ items: [] }), '2026-12-20');
    expect(content.items).toEqual([]);
    expect(content.totals).toEqual([
      { currency: 'COP', gross: 0, discount: 0, net: 0, agreementSaving: 0 },
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
      basePrice: null,
      referencePrice: null,
      agreementName: null,
      agreementPayerName: null,
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
      source({
        patient: { name: 'Ana Pérez', document: 'Documento nacional 124' },
      }),
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

/** Presupuesto firmado antes de DX-105, tal cual se guardó en el JSONB. */
const V1_STORED = {
  version: 1,
  planId: 'plan-1',
  patientId: 'patient-1',
  currency: 'COP',
  clinicName: 'Clínica Sonrisa',
  location: { id: 'loc-1', name: 'Sede principal', address: 'Calle 1 # 2-3' },
  patient: { name: 'Ana Pérez', document: 'CC 123' },
  professionalName: 'Dra. Gómez',
  issuedOn: '2026-10-16',
  validUntil: '2026-11-15',
  validityDays: 30,
  items: [
    {
      id: 'i1',
      toothNumber: '36',
      surfaces: [],
      procedure: 'Implante',
      quantity: 1,
      unitPrice: 3500000,
      discount: 350000,
      subtotal: 3150000,
    },
    {
      id: 'i2',
      toothNumber: '16',
      surfaces: ['OCCLUSAL', 'MESIAL'],
      procedure: 'Resina',
      quantity: 1,
      unitPrice: 180000.5,
      discount: 0,
      subtotal: 180000.5,
    },
  ],
  totals: [
    { currency: 'COP', gross: 3680000.5, discount: 350000, net: 3330000.5 },
  ],
};
// Calculado con el código de antes de DX-105 sobre ese mismo contenido.
const V1_HASH =
  '9e5e1673f84665948396a7e22191fc5d89c945fe90dc8c243a2c3d75cc6c94f8';

describe('presupuesto v1 firmado (DX-105, R3)', () => {
  it('su hash no cambia: el algoritmo v1 se conserva byte a byte', () => {
    const content = parseQuoteContent(V1_STORED);
    expect(content.version).toBe(1);
    expect(computeQuoteHash(content)).toBe(V1_HASH);
  });

  it('se lee con los campos nuevos vacíos', () => {
    const content = parseQuoteContent(V1_STORED);
    expect(content.agreement).toBeNull();
    expect(content.items.map((i) => i.listPrice)).toEqual([null, null]);
    expect(content.items.map((i) => i.agreementName)).toEqual([null, null]);
    expect(content.totals[0].agreementSaving).toBe(0);
  });

  it('rechaza una versión desconocida', () => {
    expect(() => parseQuoteContent({ ...V1_STORED, version: 3 })).toThrow(
      /campo version/,
    );
  });
});

describe('presupuesto v2 con convenio (DX-105)', () => {
  const withAgreement = (): QuoteContentSource =>
    source({
      items: [
        {
          ...source().items[0],
          price: 850,
          discount: 0,
          basePrice: 1000,
          referencePrice: 850,
          agreementName: 'Sura EPS −15 %',
          agreementPayerName: 'Sura EPS',
        },
        {
          ...source().items[1],
          price: 200,
          basePrice: 200,
          referencePrice: 200,
          agreementName: 'Sura EPS −15 %',
          agreementPayerName: 'Sura EPS',
        },
        {
          ...source().items[1],
          id: 'i3',
          price: 120.5,
          basePrice: 100,
          referencePrice: 120.5,
          agreementName: 'Sura EPS −15 %',
          agreementPayerName: 'Sura EPS',
        },
      ],
    });

  it('compone el convenio, el precio de lista y el ahorro (solo suma si baja)', () => {
    const content = buildQuoteContent(withAgreement(), '2026-10-16');
    expect(content.version).toBe(2);
    expect(content.agreement).toEqual({
      name: 'Sura EPS −15 %',
      payerName: 'Sura EPS',
    });
    expect(content.items.map((i) => i.listPrice)).toEqual([1000, 200, 100]);
    expect(content.items[0].agreementName).toBe('Sura EPS −15 %');
    // 150 de la primera; 0 en la segunda; la tercera sube y no resta.
    expect(content.totals[0].agreementSaving).toBe(150);
  });

  it('el ahorro mide el precio cobrado: un precio tecleado por encima no lo infla', () => {
    const items = withAgreement().items.slice(0, 1);
    const typed = (price: number) =>
      buildQuoteContent(
        source({ items: [{ ...items[0], price }] }),
        '2026-10-16',
      ).totals[0].agreementSaving;
    // lista 1000, convenio 850: cobrar 1000 no ahorra nada; 900 ahorra 100.
    expect(typed(1000)).toBe(0);
    expect(typed(900)).toBe(100);
    expect(typed(850)).toBe(150);
    expect(typed(700)).toBe(150);
  });

  it('sin convenio: agreement null, ahorro 0 y listPrice = precio de catálogo', () => {
    const content = buildQuoteContent(
      source({
        items: [
          { ...source().items[0], basePrice: 3500000, referencePrice: 3500000 },
        ],
      }),
      '2026-10-16',
    );
    expect(content.agreement).toBeNull();
    expect(content.items[0].listPrice).toBe(3500000);
    expect(content.totals[0].agreementSaving).toBe(0);
  });

  it('varios convenios: nombres juntos con « · » y pagador del primero', () => {
    const items = withAgreement().items;
    items[1] = {
      ...items[1],
      agreementName: 'Empresa Alfa lista',
      agreementPayerName: 'Empresa Alfa',
    };
    items[2] = { ...items[2], agreementName: 'Sura EPS −15 %' };
    const content = buildQuoteContent(source({ items }), '2026-10-16');
    expect(content.agreement).toEqual({
      name: 'Sura EPS −15 % · Empresa Alfa lista',
      payerName: 'Sura EPS',
    });
  });

  it('el hash v2 incluye convenio, precio de lista y ahorro', () => {
    const base = buildQuoteContent(withAgreement(), '2026-10-16');
    const hash = computeQuoteHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const variants: QuoteContent[] = [
      { ...base, agreement: { name: 'Otro', payerName: 'Sura EPS' } },
      { ...base, agreement: { name: 'Sura EPS −15 %', payerName: 'Otro' } },
      { ...base, agreement: null },
      {
        ...base,
        items: [{ ...base.items[0], listPrice: 1001 }, ...base.items.slice(1)],
      },
      {
        ...base,
        items: [
          { ...base.items[0], agreementName: null },
          ...base.items.slice(1),
        ],
      },
      {
        ...base,
        totals: [{ ...base.totals[0], agreementSaving: 151 }],
      },
    ];
    for (const variant of variants) {
      expect(computeQuoteHash(variant)).not.toBe(hash);
    }
  });

  it('v1 y v2 de los mismos datos no colisionan (versión sellada)', () => {
    const v2 = buildQuoteContent(source(), '2026-10-16');
    expect(computeQuoteHash({ ...v2, version: 1 })).not.toBe(
      computeQuoteHash(v2),
    );
    expect(QUOTE_HASH_VERSION_V2).toBe('dentalix-plan-quote-v2');
  });

  it('sobrevive a un viaje por JSON y se lee como v2', () => {
    const base = buildQuoteContent(withAgreement(), '2026-10-16');
    const back = parseQuoteContent(JSON.parse(JSON.stringify(base)));
    expect(back).toEqual(base);
    expect(computeQuoteHash(back)).toBe(computeQuoteHash(base));
  });

  it('un v2 con campos nuevos ausentes se rechaza', () => {
    expect(() => parseQuoteContent({ ...V1_STORED, version: 2 })).toThrow(
      /presupuesto guardado/,
    );
  });
});
