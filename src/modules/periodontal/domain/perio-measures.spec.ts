import {
  PERIO_FLAG,
  calMm,
  computePerioIndices,
  decodeFlags,
  encodeFlags,
  isPermanentFdi,
  validatePerioMeasures,
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
    });
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
          site(16, 'MB', { probingMm: 19, recessionMm: -5, furcation: 3 }),
          site(48, 'DL', { probingMm: 0, recessionMm: 19, furcation: 0 }),
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
