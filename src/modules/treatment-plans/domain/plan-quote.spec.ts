import {
  buildQuoteContent,
  QUOTE_HASH_VERSION_V4,
  withListPriceCurrencies,
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
    currency: 'VES',
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
        listPriceCurrency: 'VES',
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
        listPriceCurrency: 'VES',
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
        currency: 'VES',
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
      { currency: 'VES', gross: 0, discount: 0, net: 0, agreementSaving: 0 },
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
      listPriceCurrency: null,
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
  const at = new Date('2026-10-16T14:00:00.000Z');

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
      { acceptedAt: new Date('2026-10-16T14:00:00.001Z') },
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
  currency: 'VES',
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
    { currency: 'VES', gross: 3680000.5, discount: 350000, net: 3330000.5 },
  ],
};
// Foto del algoritmo v1 sobre este contenido. Se recalculó al cambiar la moneda del
// fixture, tras comprobar que el código actual reproduce el hash literal anterior
// (el de antes de DX-105) sobre el contenido previo.
const V1_HASH =
  'f73f79d6877ff561bdb8f0325581a06dd33dd411ef6badab883f60446f88af9a';

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
    expect(() => parseQuoteContent({ ...V1_STORED, version: 99 })).toThrow(
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
          agreementName: 'Surco Salud −15 %',
          agreementPayerName: 'Surco Salud',
        },
        {
          ...source().items[1],
          price: 200,
          basePrice: 200,
          referencePrice: 200,
          agreementName: 'Surco Salud −15 %',
          agreementPayerName: 'Surco Salud',
        },
        {
          ...source().items[1],
          id: 'i3',
          price: 120.5,
          basePrice: 100,
          referencePrice: 120.5,
          agreementName: 'Surco Salud −15 %',
          agreementPayerName: 'Surco Salud',
        },
      ],
    });

  it('compone el convenio, el precio de lista y el ahorro (solo suma si baja)', () => {
    const content = buildQuoteContent(withAgreement(), '2026-10-16', 'legacy');
    expect(content.version).toBe(2);
    expect(content.agreement).toEqual({
      name: 'Surco Salud −15 %',
      payerName: 'Surco Salud',
    });
    expect(content.items.map((i) => i.listPrice)).toEqual([1000, 200, 100]);
    expect(content.items[0].agreementName).toBe('Surco Salud −15 %');
    // 150 de la primera; 0 en la segunda; la tercera sube y no resta.
    expect(content.totals[0].agreementSaving).toBe(150);
  });

  it('el ahorro mide el precio cobrado: un precio tecleado por encima no lo infla', () => {
    const items = withAgreement().items.slice(0, 1);
    const typed = (price: number) =>
      buildQuoteContent(
        source({ items: [{ ...items[0], price }] }),
        '2026-10-16',
        'legacy',
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
      'legacy',
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
    items[2] = { ...items[2], agreementName: 'Surco Salud −15 %' };
    const content = buildQuoteContent(
      source({ items }),
      '2026-10-16',
      'legacy',
    );
    expect(content.agreement).toEqual({
      name: 'Surco Salud −15 % · Empresa Alfa lista',
      payerName: 'Surco Salud',
    });
  });

  it('el hash v2 incluye convenio, precio de lista y ahorro', () => {
    const base = buildQuoteContent(withAgreement(), '2026-10-16', 'legacy');
    const hash = computeQuoteHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const variants: QuoteContent[] = [
      { ...base, agreement: { name: 'Otro', payerName: 'Surco Salud' } },
      { ...base, agreement: { name: 'Surco Salud −15 %', payerName: 'Otro' } },
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
    const v2 = buildQuoteContent(source(), '2026-10-16', 'legacy');
    expect(computeQuoteHash({ ...v2, version: 1 })).not.toBe(
      computeQuoteHash(v2),
    );
    expect(QUOTE_HASH_VERSION_V2).toBe('dentalix-plan-quote-v2');
  });

  it('sobrevive a un viaje por JSON y se lee como v2', () => {
    const base = buildQuoteContent(withAgreement(), '2026-10-16', 'legacy');
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

describe('datos fiscales congelados (DX-019)', () => {
  const FISCAL = {
    legalName: 'Sonrisas S.A.',
    taxIdLabel: 'ID fiscal',
    taxId: 'J-1',
    address: null,
    email: null,
    phone: null,
  };
  const EMPTY = { ...FISCAL, legalName: null, taxIdLabel: null, taxId: null };

  it('recompuesto con la regla de antes de DX-502: sin datos v2 y el hash no cambia; con datos, v3 y los sella', () => {
    const plain = buildQuoteContent(source(), '2026-10-16', 'legacy');
    const empty = buildQuoteContent(
      { ...source(), clinicFiscal: EMPTY },
      '2026-10-16',
      'legacy',
    );
    expect(empty.version).toBe(2);
    expect(empty.clinicFiscal).toBeNull();
    expect(computeQuoteHash(empty)).toBe(computeQuoteHash(plain));

    const frozen = buildQuoteContent(
      { ...source(), clinicFiscal: FISCAL },
      '2026-10-16',
      'legacy',
    );
    expect(frozen.version).toBe(3);
    expect(computeQuoteHash(frozen)).not.toBe(computeQuoteHash(plain));
    const other = { ...frozen, clinicFiscal: { ...FISCAL, taxId: 'J-2' } };
    expect(computeQuoteHash(other)).not.toBe(computeQuoteHash(frozen));
  });

  it('una foto v3 guardada se lee igual y sigue validando; una v2 da null', () => {
    const frozen = buildQuoteContent(
      { ...source(), clinicFiscal: FISCAL },
      '2026-10-16',
      'legacy',
    );
    const stored: unknown = JSON.parse(JSON.stringify(frozen));
    const parsed = parseQuoteContent(stored);
    expect(parsed.clinicFiscal).toEqual(FISCAL);
    expect(computeQuoteHash(parsed)).toBe(computeQuoteHash(frozen));
    expect(
      parseQuoteContent(
        JSON.parse(
          JSON.stringify(buildQuoteContent(source(), '2026-10-16', 'legacy')),
        ),
      ).clinicFiscal,
    ).toBeNull();
  });

  it('la v4 (DX-502) sella los datos fiscales si los hay y se lee con ellos', () => {
    const plain = buildQuoteContent(source(), '2026-10-16');
    const empty = buildQuoteContent(
      { ...source(), clinicFiscal: EMPTY },
      '2026-10-16',
    );
    expect(plain.version).toBe(4);
    expect(empty.version).toBe(4);
    expect(empty.clinicFiscal).toBeNull();
    expect(computeQuoteHash(empty)).toBe(computeQuoteHash(plain));
    const frozen = buildQuoteContent(
      { ...source(), clinicFiscal: FISCAL },
      '2026-10-16',
    );
    expect(frozen.version).toBe(4);
    expect(computeQuoteHash(frozen)).not.toBe(computeQuoteHash(plain));
    const other = { ...frozen, clinicFiscal: { ...FISCAL, taxId: 'J-2' } };
    expect(computeQuoteHash(other)).not.toBe(computeQuoteHash(frozen));
    const parsed = parseQuoteContent(JSON.parse(JSON.stringify(frozen)));
    expect(parsed.clinicFiscal).toEqual(FISCAL);
    expect(computeQuoteHash(parsed)).toBe(computeQuoteHash(frozen));
    expect(
      parseQuoteContent(JSON.parse(JSON.stringify(plain))).clinicFiscal,
    ).toBeNull();
  });

  it('la v4 no colisiona con la v3 de los mismos datos fiscales', () => {
    const v4 = buildQuoteContent(
      { ...source(), clinicFiscal: FISCAL },
      '2026-10-16',
    );
    expect(computeQuoteHash({ ...v4, version: 3 })).not.toBe(
      computeQuoteHash(v4),
    );
  });
});

describe('presupuesto v4 con la moneda del catálogo (DX-502)', () => {
  /** Plan en EUR: un ítem de convenio con el catálogo en VES y otro en EUR. */
  const eurPlan = (): QuoteContentSource =>
    source({
      currency: 'EUR',
      items: [
        {
          ...source().items[0],
          price: 100.55,
          discount: 0,
          basePrice: 80000,
          referencePrice: 100.55,
          agreementName: 'Lista Euro',
          agreementPayerName: 'Aseguradora',
          listPriceCurrency: 'VES',
        },
        {
          ...source().items[1],
          id: 'i3',
          price: 85,
          discount: 0,
          basePrice: 100,
          referencePrice: 85,
          agreementName: 'Lista Euro',
          agreementPayerName: 'Aseguradora',
          listPriceCurrency: 'EUR',
        },
      ],
    });

  it('se compone como v4 y cada precio de lista lleva la moneda del catálogo', () => {
    const content = buildQuoteContent(eurPlan(), '2026-11-01');
    expect(content.version).toBe(4);
    expect(
      content.items.map((i) => [i.listPrice, i.listPriceCurrency]),
    ).toEqual([
      [80000, 'VES'],
      [100, 'EUR'],
    ]);
  });

  it('el ahorro por convenio no resta un precio de lista en otra moneda', () => {
    const content = buildQuoteContent(eurPlan(), '2026-11-01');
    // Solo el ítem con el catálogo en EUR: 100 − 85. Nunca 80.000 VES − 100,55 EUR.
    expect(content.totals[0].agreementSaving).toBe(15);
  });

  it('sin moneda del catálogo conocida, tampoco hay ahorro', () => {
    const [cop] = eurPlan().items;
    const content = buildQuoteContent(
      source({ currency: 'EUR', items: [{ ...cop, listPriceCurrency: null }] }),
      '2026-11-01',
    );
    expect(content.items[0].listPriceCurrency).toBeNull();
    expect(content.totals[0].agreementSaving).toBe(0);
  });

  it('el hash v4 sella la moneda del precio de lista', () => {
    const base = buildQuoteContent(eurPlan(), '2026-11-01');
    const changed: QuoteContent = {
      ...base,
      items: [
        { ...base.items[0], listPriceCurrency: 'USD' },
        ...base.items.slice(1),
      ],
    };
    expect(computeQuoteHash(changed)).not.toBe(computeQuoteHash(base));
    expect(QUOTE_HASH_VERSION_V4).toBe('dentalix-plan-quote-v4');
  });

  it('sobrevive a un viaje por JSON y se lee como v4', () => {
    const base = buildQuoteContent(eurPlan(), '2026-11-01');
    const back = parseQuoteContent(JSON.parse(JSON.stringify(base)));
    expect(back).toEqual(base);
    expect(computeQuoteHash(back)).toBe(computeQuoteHash(base));
  });

  it('un v4 sin la moneda del precio de lista se rechaza', () => {
    const base = JSON.parse(
      JSON.stringify(buildQuoteContent(eurPlan(), '2026-11-01')),
    ) as { items: Record<string, unknown>[] };
    delete base.items[0].listPriceCurrency;
    expect(() => parseQuoteContent(base)).toThrow(/campo listPriceCurrency/);
  });

  it('un enlace v2 se recompone igual: su hash no cambia (enlaces ya enviados)', () => {
    const content = buildQuoteContent(
      source({
        items: [
          {
            ...source().items[0],
            price: 850,
            discount: 0,
            basePrice: 1000,
            referencePrice: 850,
            agreementName: 'Surco Salud −15 %',
            agreementPayerName: 'Surco Salud',
          },
        ],
      }),
      '2026-10-16',
      'legacy',
    );
    expect(content.items[0].listPriceCurrency).toBeNull();
    // Calculado con el código de main anterior a DX-502 sobre los mismos datos.
    expect(computeQuoteHash(content)).toBe(
      '84ed27138352b0d8544141caf0e98e5d5901c2e69b16cdf91a3277c3472fc0d5',
    );
  });

  it('un enlace v3 (DX-019) se recompone igual, aunque el catálogo esté en otra moneda', () => {
    const content = buildQuoteContent(
      source({
        clinicFiscal: {
          legalName: 'Sonrisas S.A.',
          taxIdLabel: 'ID fiscal',
          taxId: 'J-1',
          address: null,
          email: null,
          phone: null,
        },
        items: [
          {
            ...source().items[0],
            price: 850,
            discount: 0,
            basePrice: 1000,
            referencePrice: 850,
            agreementName: 'Surco Salud −15 %',
            agreementPayerName: 'Surco Salud',
            listPriceCurrency: 'EUR',
          },
        ],
      }),
      '2026-10-16',
      'legacy',
    );
    expect(content.version).toBe(3);
    expect(content.items[0].listPriceCurrency).toBeNull();
    // Calculado con el código de main anterior a DX-502 sobre los mismos datos.
    expect(computeQuoteHash(content)).toBe(
      'f8720e03c153cc9144d9f22d6ed8f70b6c64a112873966c19f806b467a5edd55',
    );
  });

  it('un v3, v2 o v1 se lee sin moneda y se completa con la de los ítems del plan', () => {
    const v2 = buildQuoteContent(eurPlan(), '2026-11-01', 'legacy');
    const stored = parseQuoteContent(JSON.parse(JSON.stringify(v2)));
    expect(stored.items.map((i) => i.listPriceCurrency)).toEqual([null, null]);
    const filled = withListPriceCurrencies(stored, [
      { id: 'i1', listPriceCurrency: 'VES' },
    ]);
    expect(filled.items.map((i) => i.listPriceCurrency)).toEqual(['VES', null]);
    // Completar no toca lo sellado.
    expect(computeQuoteHash(filled)).toBe(computeQuoteHash(stored));
  });

  it('un v4 no se completa: conserva la moneda con la que se emitió', () => {
    const v4 = buildQuoteContent(eurPlan(), '2026-11-01');
    const filled = withListPriceCurrencies(v4, [
      { id: 'i1', listPriceCurrency: 'USD' },
    ]);
    expect(filled.items[0].listPriceCurrency).toBe('VES');
  });
});
