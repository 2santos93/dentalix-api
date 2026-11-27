import {
  PERIO_FLAG,
  calMm,
  computePerioIndices,
  countPerioSites,
  indicesFromCounts,
  decodeFlags,
  encodeFlags,
  furcationSites,
  isPermanentFdi,
  perioThresholdsCode,
  validatePerioMeasures,
  validatePerioThresholds,
} from './perio-measures';
import type {
  PerioSiteMeasure,
  PerioToothMeasure,
} from './entities/perio-exam.entity';

function site(
  toothFdi: number,
  s: PerioSiteMeasure['site'],
  extra: Partial<PerioSiteMeasure> = {},
): PerioSiteMeasure {
  return {
    toothFdi,
    site: s,
    probingMm: null,
    recessionMm: null,
    furcation: null,
    bleeding: false,
    suppuration: false,
    plaque: false,
    calculus: false,
    ...extra,
  };
}

describe('isPermanentFdi', () => {
  it.each([11, 18, 21, 28, 31, 38, 41, 48])('%i es válido', (fdi) => {
    expect(isPermanentFdi(fdi)).toBe(true);
  });
  it.each([10, 19, 51, 55, 49, 9, 0, 88, 11.5])('%p no es válido', (fdi) => {
    expect(isPermanentFdi(fdi)).toBe(false);
  });
});

describe('flags', () => {
  it('codifica y decodifica el bitmask BOP=1|SUP=2|PLAQ=4|CALC=8', () => {
    expect(PERIO_FLAG).toEqual({ BOP: 1, SUP: 2, PLAQ: 4, CALC: 8 });
    const mask = encodeFlags({
      bleeding: true,
      suppuration: false,
      plaque: true,
      calculus: true,
    });
    expect(mask).toBe(13);
    expect(decodeFlags(mask)).toEqual({
      bleeding: true,
      suppuration: false,
      plaque: true,
      calculus: true,
    });
    expect(decodeFlags(0)).toEqual({
      bleeding: false,
      suppuration: false,
      plaque: false,
      calculus: false,
    });
  });
});

describe('calMm (NIC = sondaje + recesión)', () => {
  it('suma sondaje y recesión', () => {
    expect(calMm(4, 2)).toBe(6);
  });
  it('recesión negativa (margen coronal a la UAC) resta', () => {
    expect(calMm(5, -2)).toBe(3);
  });
  it('sin recesión registrada, NIC = sondaje', () => {
    expect(calMm(3, null)).toBe(3);
  });
  it('sin sondaje no hay NIC', () => {
    expect(calMm(null, 2)).toBeNull();
  });
  it('nunca negativo', () => {
    expect(calMm(1, -5)).toBe(0);
  });
});

describe('computePerioIndices', () => {
  it('sin datos: todo a cero', () => {
    expect(computePerioIndices([], [])).toEqual({
      sitesExamined: 0,
      bopPercent: 0,
      plaquePercent: 0,
      sites4mmOrMore: 0,
      sites6mmOrMore: 0,
      sitesAlertOrMore: 0,
      sitesSevereOrMore: 0,
    });
  });

  it('calcula BOP%, placa% y sitios ≥4/≥6 excluyendo dientes omitidos', () => {
    const sites = [
      site(16, 'MB', { probingMm: 3, bleeding: true }),
      site(16, 'B', { probingMm: 4, plaque: true }),
      site(16, 'DB', { probingMm: 6, bleeding: true, plaque: true }),
      site(11, 'MB', { probingMm: 2 }),
      // 18 está omitido: no cuenta aunque tenga datos.
      site(18, 'MB', { probingMm: 9, bleeding: true, plaque: true }),
      // Sitio sin sondaje ni flags: no se examinó.
      site(11, 'B'),
    ];
    const teeth: PerioToothMeasure[] = [
      { toothFdi: 18, mobility: null, skipped: true },
      { toothFdi: 16, mobility: 1, skipped: false },
    ];
    expect(computePerioIndices(sites, teeth)).toEqual({
      sitesExamined: 4,
      bopPercent: 50,
      plaquePercent: 50,
      sites4mmOrMore: 2,
      sites6mmOrMore: 1,
      // Sin umbrales de la clínica: los de fábrica (4 y 6).
      sitesAlertOrMore: 2,
      sitesSevereOrMore: 1,
    });
  });

  it('DX-066: los sitios en alerta y severos siguen los umbrales de la clínica; ≥4/≥6 no cambian', () => {
    const sites = [
      site(16, 'MB', { probingMm: 3 }),
      site(16, 'B', { probingMm: 4 }),
      site(16, 'DB', { probingMm: 5 }),
      site(26, 'MB', { probingMm: 6 }),
      site(26, 'B', { probingMm: 7 }),
      site(18, 'MB', { probingMm: 9 }),
    ];
    const teeth = [{ toothFdi: 18, mobility: null, skipped: true }];
    expect(
      computePerioIndices(sites, teeth, { pdAlertMm: 5, pdSevereMm: 7 }),
    ).toMatchObject({
      sites4mmOrMore: 4,
      sites6mmOrMore: 2,
      sitesAlertOrMore: 3,
      sitesSevereOrMore: 1,
    });
    expect(
      computePerioIndices(sites, teeth, { pdAlertMm: 3, pdSevereMm: 4 }),
    ).toMatchObject({ sitesAlertOrMore: 5, sitesSevereOrMore: 4 });
  });

  it('un sitio con solo sangrado (sin sondaje) cuenta como examinado', () => {
    const result = computePerioIndices(
      [site(21, 'B', { bleeding: true }), site(21, 'MB', { probingMm: 2 })],
      [],
    );
    expect(result.sitesExamined).toBe(2);
    expect(result.bopPercent).toBe(50);
  });

  it('redondea a un decimal', () => {
    const result = computePerioIndices(
      [
        site(11, 'MB', { probingMm: 2, bleeding: true }),
        site(11, 'B', { probingMm: 2 }),
        site(11, 'DB', { probingMm: 2 }),
      ],
      [],
    );
    expect(result.bopPercent).toBe(33.3);
  });
});

describe('validatePerioMeasures', () => {
  it('acepta medidas válidas', () => {
    expect(
      validatePerioMeasures({
        sites: [
          site(16, 'MB', { probingMm: 19, recessionMm: -5 }),
          site(16, 'B', { furcation: 3 }),
          site(48, 'DL', { probingMm: 0, recessionMm: 19 }),
          site(48, 'L', { furcation: 0 }),
        ],
        teeth: [{ toothFdi: 16, mobility: 3, skipped: false }],
      }),
    ).toEqual([]);
  });

  it.each([
    [
      { toothFdi: 19 },
      'Diente 19 no es un diente permanente válido (FDI 11–48)',
    ],
    [
      { toothFdi: 55 },
      'Diente 55 no es un diente permanente válido (FDI 11–48)',
    ],
    [{ site: 'X' }, 'Diente 16: sitio «X» no válido (MB, B, DB, ML, L, DL)'],
    [
      { probingMm: 20 },
      'Diente 16, sitio MB: el sondaje debe ser un entero entre 0 y 19 mm',
    ],
    [
      { probingMm: -1 },
      'Diente 16, sitio MB: el sondaje debe ser un entero entre 0 y 19 mm',
    ],
    [
      { probingMm: 2.5 },
      'Diente 16, sitio MB: el sondaje debe ser un entero entre 0 y 19 mm',
    ],
    [
      { recessionMm: -6 },
      'Diente 16, sitio MB: la recesión debe ser un entero entre -5 y 19 mm',
    ],
    [
      { recessionMm: 20 },
      'Diente 16, sitio MB: la recesión debe ser un entero entre -5 y 19 mm',
    ],
    [{ furcation: 4 }, 'Diente 16, sitio MB: la furca debe ser 0, 1, 2 o 3'],
    [
      { furcation: 1 },
      'Diente 16, sitio MB: la furca solo se registra en molares: superiores en B, MP (sitio ML) y DP (sitio DL); inferiores en B y L',
    ],
  ])('rechaza %p', (extra, message) => {
    const errors = validatePerioMeasures({
      sites: [site(16, 'MB', extra as Partial<PerioSiteMeasure>)],
      teeth: [],
    });
    expect(errors).toEqual([message]);
  });

  it('rechaza movilidad fuera de rango y dientes inválidos', () => {
    expect(
      validatePerioMeasures({
        sites: [],
        teeth: [
          { toothFdi: 21, mobility: 4, skipped: false },
          { toothFdi: 60, mobility: null, skipped: true },
        ],
      }),
    ).toEqual([
      'Diente 21: la movilidad debe ser 0, 1, 2 o 3',
      'Diente 60 no es un diente permanente válido (FDI 11–48)',
    ]);
  });

  it('rechaza duplicados', () => {
    expect(
      validatePerioMeasures({
        sites: [site(16, 'MB'), site(16, 'MB')],
        teeth: [
          { toothFdi: 16, mobility: null, skipped: false },
          { toothFdi: 16, mobility: 1, skipped: false },
        ],
      }),
    ).toEqual([
      'Diente 16, sitio MB: está repetido',
      'Diente 16: está repetido',
    ]);
  });
});

describe('countPerioSites / indicesFromCounts (DX-103)', () => {
  it('los índices desde conteos (lista) son los mismos que desde las medidas (detalle)', () => {
    const sites = [
      site(16, 'MB', { probingMm: 6, bleeding: true }),
      site(16, 'B', { probingMm: 4, plaque: true }),
      site(16, 'DB', { suppuration: true }),
      site(18, 'MB', { probingMm: 9, bleeding: true }),
      site(21, 'L'),
    ];
    const teeth = [{ toothFdi: 18, mobility: null, skipped: true }];
    const counts = countPerioSites(sites, teeth);
    expect(counts).toEqual({
      sitesExamined: 3,
      bleedingSites: 1,
      plaqueSites: 1,
      sites4mmOrMore: 2,
      sites6mmOrMore: 1,
      sitesAlertOrMore: 2,
      sitesSevereOrMore: 1,
    });
    expect(indicesFromCounts(counts)).toEqual(
      computePerioIndices(sites, teeth),
    );
    expect(indicesFromCounts(counts).bopPercent).toBe(33.3);
  });
});

describe('furca por sitio (DX-066)', () => {
  it('molares superiores: B, MP (ML) y DP (DL); inferiores: B y L; el resto, ninguno', () => {
    for (const fdi of [16, 17, 18, 26, 27, 28]) {
      expect(furcationSites(fdi)).toEqual(['B', 'ML', 'DL']);
    }
    for (const fdi of [36, 37, 38, 46, 47, 48]) {
      expect(furcationSites(fdi)).toEqual(['B', 'L']);
    }
    for (const fdi of [11, 13, 14, 15, 24, 25, 34, 45, 19, 55]) {
      expect(furcationSites(fdi)).toEqual([]);
    }
  });

  it('acepta la furca MP/DP de un molar superior y rechaza la de un incisivo o la palatina central', () => {
    expect(
      validatePerioMeasures({
        sites: [
          site(26, 'ML', { furcation: 2 }),
          site(26, 'DL', { furcation: 1 }),
          site(17, 'B', { furcation: 3 }),
        ],
        teeth: [],
      }),
    ).toEqual([]);
    const errors = validatePerioMeasures({
      sites: [
        site(11, 'B', { furcation: 1 }),
        site(16, 'L', { furcation: 1 }),
        site(36, 'ML', { furcation: 1 }),
      ],
      teeth: [],
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^Diente 11, sitio B: la furca solo se registra/);
    expect(errors[1]).toMatch(/^Diente 16, sitio L: /);
    expect(errors[2]).toMatch(/^Diente 36, sitio ML: /);
  });

  it('una furca vacía (null) se puede mandar en cualquier sitio: limpia la celda', () => {
    expect(
      validatePerioMeasures({
        sites: [site(11, 'B', { furcation: null, probingMm: 2 })],
        teeth: [],
      }),
    ).toEqual([]);
  });

  it('CALC viaja en el bitmask y cuenta como sitio examinado', () => {
    expect(
      encodeFlags({
        bleeding: false,
        suppuration: false,
        plaque: false,
        calculus: true,
      }),
    ).toBe(PERIO_FLAG.CALC);
    expect(
      computePerioIndices([site(31, 'L', { calculus: true })], [])
        .sitesExamined,
    ).toBe(1);
  });
});

describe('umbrales de sondaje (DX-066)', () => {
  it('acepta enteros en rango con alerta < severo', () => {
    expect(validatePerioThresholds({ pdAlertMm: 4, pdSevereMm: 6 })).toEqual(
      [],
    );
    expect(validatePerioThresholds({ pdAlertMm: 2, pdSevereMm: 3 })).toEqual(
      [],
    );
    expect(validatePerioThresholds({ pdAlertMm: 10, pdSevereMm: 12 })).toEqual(
      [],
    );
  });

  it.each([
    [
      { pdAlertMm: 1, pdSevereMm: 6 },
      ['El umbral de alerta debe ser un entero entre 2 y 10 mm'],
    ],
    [
      { pdAlertMm: 4.5, pdSevereMm: 6 },
      ['El umbral de alerta debe ser un entero entre 2 y 10 mm'],
    ],
    [
      { pdAlertMm: '4', pdSevereMm: 6 },
      ['El umbral de alerta debe ser un entero entre 2 y 10 mm'],
    ],
    [
      { pdAlertMm: 4, pdSevereMm: 13 },
      ['El umbral severo debe ser un entero entre 3 y 12 mm'],
    ],
    [
      { pdAlertMm: 6, pdSevereMm: 6 },
      ['El umbral de alerta debe ser menor que el severo'],
    ],
    [
      { pdAlertMm: 7, pdSevereMm: 5 },
      ['El umbral de alerta debe ser menor que el severo'],
    ],
  ])('rechaza %p', (input, errors) => {
    expect(validatePerioThresholds(input)).toEqual(errors);
  });

  it('código de auditoría', () => {
    expect(perioThresholdsCode({ pdAlertMm: 4, pdSevereMm: 6 })).toBe(
      'PD_A4_S6',
    );
  });
});
