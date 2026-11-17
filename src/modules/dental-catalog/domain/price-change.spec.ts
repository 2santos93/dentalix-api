import { CatalogKind, Prisma } from '@prisma/client';
import {
  computeNewPrice,
  matchesPriceChangeFilters,
  planPriceChange,
  priceChangeRequestFingerprint,
  type PriceChangeCandidate,
  type PriceChangeCriteria,
} from './price-change';

const D = (value: string | number) => new Prisma.Decimal(value);

function criteria(
  partial: Partial<PriceChangeCriteria> = {},
): PriceChangeCriteria {
  return {
    filters: {},
    mode: 'PERCENT',
    value: D(5),
    roundTo: null,
    minIncrement: null,
    ...partial,
  };
}

function item(
  code: string,
  price: string | null,
  extra: Partial<PriceChangeCandidate> = {},
): PriceChangeCandidate {
  return {
    id: `00000000-0000-4000-8000-${code.padStart(12, '0')}`,
    code,
    labelEs: `Procedimiento ${code}`,
    category: 'Prevención',
    kind: CatalogKind.PROCEDURE,
    active: true,
    defaultPrice: price === null ? null : D(price),
    ...extra,
  };
}

function priced(before: string | null, c: Partial<PriceChangeCriteria>) {
  const result = computeNewPrice(
    before === null ? null : D(before),
    criteria(c),
  );
  return result.kind === 'priced' ? result.after.toFixed(2) : result.reason;
}

describe('DX-205 · computeNewPrice', () => {
  describe('porcentaje', () => {
    it('sube un 5 % sin redondeo, a céntimos (mitad hacia arriba)', () => {
      expect(priced('35.00', {})).toBe('36.75');
      // 12.35 × 1.05 = 12.9675 → 12.97
      expect(priced('12.35', {})).toBe('12.97');
    });

    it('sube un 5 % y redondea a 100 unidades (VES)', () => {
      // 1.840 × 1,05 = 1.932 → 1.900
      expect(priced('1840.00', { roundTo: 100 })).toBe('1900.00');
      // 2.000 × 1,05 = 2.100 → 2.100
      expect(priced('2000.00', { roundTo: 100 })).toBe('2100.00');
      // 1.000 × 1,05 = 1.050 → 1.100 (la mitad sube)
      expect(priced('1000.00', { roundTo: 100 })).toBe('1100.00');
    });

    it('redondea a 1, 10 y 1.000', () => {
      // 36,75 → 37
      expect(priced('35.00', { roundTo: 1 })).toBe('37.00');
      // 80 × 1,05 = 84 → 80 (por debajo de antes no, queda igual)
      expect(priced('80.00', { roundTo: 10 })).toBe('UNCHANGED');
      // 90 × 1,05 = 94,5 → 90… igual; 96 × 1,05 = 100,8 → 100
      expect(priced('96.00', { roundTo: 10 })).toBe('100.00');
      // 12.000 × 1,05 = 12.600 → 13.000
      expect(priced('12000.00', { roundTo: 1000 })).toBe('13000.00');
    });

    it('baja un 10 %', () => {
      expect(priced('50.00', { value: D(-10) })).toBe('45.00');
    });

    it('bajar un 100 % deja el precio en 0, nunca negativo', () => {
      expect(priced('50.00', { value: D(-100) })).toBe('0.00');
    });

    it('un precio 0 no cambia con un %', () => {
      expect(priced('0.00', {})).toBe('UNCHANGED');
    });
  });

  describe('importe fijo', () => {
    it('suma y resta un importe', () => {
      expect(priced('40.00', { mode: 'AMOUNT', value: D('2.50') })).toBe(
        '42.50',
      );
      expect(priced('40.00', { mode: 'AMOUNT', value: D(-15) })).toBe('25.00');
    });

    it('una bajada mayor que el precio deja 0, nunca negativo', () => {
      expect(priced('10.00', { mode: 'AMOUNT', value: D(-25) })).toBe('0.00');
    });

    it('un precio 0 sube con un importe fijo', () => {
      expect(priced('0.00', { mode: 'AMOUNT', value: D(5) })).toBe('5.00');
    });
  });

  describe('redondeo que contradice el sentido del cambio', () => {
    it('una subida que el redondeo devolvería por debajo queda igual', () => {
      // 35 × 1,05 = 36,75 → a 100 sería 0: no se baja en una subida.
      expect(priced('35.00', { roundTo: 100 })).toBe('UNCHANGED');
    });

    it('una bajada que el redondeo subiría queda igual', () => {
      // 1.040 − 1 % = 1.029,60 → a 100 sería 1.000 (baja, vale)
      expect(priced('1040.00', { value: D(-1), roundTo: 100 })).toBe('1000.00');
      // 1.010 − 1 % = 999,90 → a 1.000 sería 1.000 (< 1.010, vale)
      expect(priced('1010.00', { value: D(-1), roundTo: 1000 })).toBe(
        '1000.00',
      );
      // 960 − 1 % = 950,40 → a 1.000 sería 1.000 (> 960): queda igual
      expect(priced('960.00', { value: D(-1), roundTo: 1000 })).toBe(
        'UNCHANGED',
      );
    });
  });

  describe('incremento mínimo', () => {
    it('si el % sube menos que el mínimo, sube el mínimo', () => {
      // 20 × 1,05 = 21 → +1 < 2: sube 2
      expect(priced('20.00', { minIncrement: D(2) })).toBe('22.00');
    });

    it('si el % ya sube más que el mínimo, manda el %', () => {
      expect(priced('100.00', { minIncrement: D(2) })).toBe('105.00');
    });

    it('con redondeo, antes + mínimo se redondea hacia arriba a la unidad', () => {
      // 35 × 1,05 → a 100 queda igual (35); el mínimo de 1 lo sube a 100.
      expect(priced('35.00', { roundTo: 100, minIncrement: D(1) })).toBe(
        '100.00',
      );
      // 1.940 × 1,05 = 2.037 → 2.000 (+60) < 150: 2.090 → 2.100
      expect(priced('1940.00', { roundTo: 100, minIncrement: D(150) })).toBe(
        '2100.00',
      );
    });

    it('con un importe fijo menor que el mínimo, sube el mínimo', () => {
      expect(
        priced('40.00', { mode: 'AMOUNT', value: D(1), minIncrement: D(3) }),
      ).toBe('43.00');
    });

    it('no se aplica a una bajada', () => {
      expect(priced('50.00', { value: D(-10), minIncrement: D(20) })).toBe(
        '45.00',
      );
    });
  });

  describe('precios nulos y tope', () => {
    it('sin precio por defecto se omite (NO_PRICE), con % o con importe', () => {
      expect(priced(null, {})).toBe('NO_PRICE');
      expect(priced(null, { mode: 'AMOUNT', value: D(10) })).toBe('NO_PRICE');
    });

    it('un precio que pasaría del tope de la columna se omite', () => {
      expect(priced('9999999999.00', { value: D(10) })).toBe('OUT_OF_RANGE');
    });
  });
});

describe('DX-205 · filtros', () => {
  it('categoría sin distinguir mayúsculas ni espacios', () => {
    const it1 = item('1', '10.00');
    expect(matchesPriceChangeFilters(it1, { category: ' prevención ' })).toBe(
      true,
    );
    expect(matchesPriceChangeFilters(it1, { category: 'Cirugía' })).toBe(false);
  });

  it('tipo, solo activos y «precio menor que X» (los nulos no entran)', () => {
    const diag = item('2', '10.00', { kind: CatalogKind.DIAGNOSIS });
    const inactive = item('3', '10.00', { active: false });
    const pricey = item('4', '500.00');
    const noPrice = item('5', null);
    expect(
      matchesPriceChangeFilters(diag, { kind: CatalogKind.PROCEDURE }),
    ).toBe(false);
    expect(matchesPriceChangeFilters(inactive, { activeOnly: true })).toBe(
      false,
    );
    expect(matchesPriceChangeFilters(inactive, { activeOnly: false })).toBe(
      true,
    );
    expect(matchesPriceChangeFilters(pricey, { priceBelow: D(500) })).toBe(
      false,
    );
    expect(matchesPriceChangeFilters(pricey, { priceBelow: D('500.01') })).toBe(
      true,
    );
    expect(matchesPriceChangeFilters(noPrice, { priceBelow: D(500) })).toBe(
      false,
    );
  });
});

describe('DX-205 · planPriceChange', () => {
  const items = [
    item('B', '2000.00'),
    item('A', '1840.00'),
    item('C', null),
    item('D', '35.00'),
    item('E', '100.00', { category: 'Cirugía' }),
  ];
  const c = criteria({
    filters: { category: 'Prevención' },
    roundTo: 100,
  });

  it('ordena por código, separa omitidos y suma los totales en Decimal', () => {
    const plan = planPriceChange(items, c, 'VES');
    expect(plan.lines.map((l) => [l.item.code, l.after.toFixed(2)])).toEqual([
      ['A', '1900.00'],
      ['B', '2100.00'],
    ]);
    expect(plan.skipped.map((s) => [s.item.code, s.reason])).toEqual([
      ['C', 'NO_PRICE'],
      ['D', 'UNCHANGED'],
    ]);
    expect(plan.totals.before.toFixed(2)).toBe('3840.00');
    expect(plan.totals.after.toFixed(2)).toBe('4000.00');
    expect(plan.previewHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la misma entrada da la misma huella; otro precio, otra moneda u otros criterios, otra', () => {
    const base = planPriceChange(items, c, 'VES').previewHash;
    expect(planPriceChange([...items].reverse(), c, 'VES').previewHash).toBe(
      base,
    );
    expect(planPriceChange(items, c, 'USD').previewHash).not.toBe(base);
    const moved = items.map((i) =>
      i.code === 'A' ? { ...i, defaultPrice: D('1850.00') } : i,
    );
    expect(planPriceChange(moved, c, 'VES').previewHash).not.toBe(base);
    expect(
      planPriceChange(items, { ...c, roundTo: 10 }, 'VES').previewHash,
    ).not.toBe(base);
  });

  it('ningún ítem cumple el filtro: lote vacío', () => {
    const plan = planPriceChange(
      items,
      criteria({ filters: { category: 'Ortodoncia' } }),
      'USD',
    );
    expect(plan.lines).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.totals.after.toFixed(2)).toBe('0.00');
  });

  it('la huella de la petición cambia con la vista previa', () => {
    const a = priceChangeRequestFingerprint(c, 'a'.repeat(64));
    expect(priceChangeRequestFingerprint(c, 'A'.repeat(64))).toBe(a);
    expect(priceChangeRequestFingerprint(c, 'b'.repeat(64))).not.toBe(a);
  });
});
