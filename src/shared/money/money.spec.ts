import fc from 'fast-check';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  amountText,
  averageAmount,
  averageCents,
  fromCents,
  round2,
  roundCents,
  toCents,
} from './money';
import * as money from './money';

describe('dinero en centavos (src/shared/money, DX-054)', () => {
  it('toCents redondea al centavo entero (0.1 + 0.2 suma exacto)', () => {
    expect(toCents(0.1) + toCents(0.2)).toBe(30);
    expect(toCents(1.005)).toBe(100);
    expect(toCents(19.999)).toBe(2000);
    expect(toCents(-2.5)).toBe(-250);
    expect(toCents(150000)).toBe(15_000_000);
  });

  it('fromCents vuelve a unidades', () => {
    expect(fromCents(30)).toBe(0.3);
    expect(fromCents(-250)).toBe(-2.5);
    expect(fromCents(toCents(1234.56))).toBe(1234.56);
  });

  it('round2 redondea a 2 decimales, como toCents/100', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(100.314999)).toBe(100.31);
    expect(round2(400000 / 4000)).toBe(100);
    expect(round2(-1.234)).toBe(-1.23);
  });
});

describe('helpers de DX-488 (mismos resultados que el código en línea)', () => {
  it('roundCents es Math.round', () => {
    expect(roundCents(12_345)).toBe(12_345);
    expect(roundCents(12_345.4)).toBe(12_345);
    expect(roundCents(12_345.5)).toBe(12_346);
    expect(roundCents(0)).toBe(0);
  });

  it('amountText es toFixed, en USD, VES y JPY', () => {
    expect(amountText(1234.5, 2)).toBe('1234.50');
    expect(amountText(36.5, 2)).toBe('36.50'); // VES
    expect(amountText(1500, 0)).toBe('1500'); // JPY
    expect(amountText(0.1 + 0.2, 2)).toBe('0.30');
    // toFixed escribe el valor binario exacto: 1.005 es 1.00499999…
    expect(amountText(1.005, 2)).toBe('1.00');
    expect(amountText(2.675, 2)).toBe('2.67');
  });
});

describe('promedios de importes exactos en céntimos (DX-488)', () => {
  it('los empates suben a la mitad hacia arriba, también donde fallaban los dos redondeos de coma flotante', () => {
    expect(averageCents(201, 2)).toBe(101); // 1.005 → 1.01
    expect(averageCents(427, 2)).toBe(214); // 2.135 → 2.14 (el épsilon daba 2.13)
    expect(averageCents(803, 2)).toBe(402); // 4.015 → 4.02 (el épsilon daba 4.01)
    expect(averageCents(29, 2)).toBe(15); // 0.145 → 0.15 (round2 daba 0.14)
    expect(averageCents(26000, 3)).toBe(8667); // 86.67, sin empate
    expect(averageCents(1, 3)).toBe(0);
    expect(averageCents(2, 3)).toBe(1);
  });

  it('cero entre n es cero', () => {
    expect(averageCents(0, 5)).toBe(0);
    expect(averageAmount(0, 5)).toBe(0);
  });

  it('negativos: la mitad hacia arriba, como Math.round (−1.005 → −1.00)', () => {
    expect(averageCents(-201, 2)).toBe(-100);
    expect(averageCents(-427, 2)).toBe(-213);
    expect(averageCents(-26000, 3)).toBe(-8667);
    expect(averageCents(-1, 3)).toBe(0);
  });

  it('n = 0 (o no entero) no es un promedio: error explícito', () => {
    expect(() => averageCents(100, 0)).toThrow(RangeError);
    expect(() => averageCents(100, -1)).toThrow(RangeError);
    expect(() => averageCents(100, 1.5)).toThrow(RangeError);
    expect(() => averageCents(100.5, 2)).toThrow(RangeError);
  });

  it('averageAmount: importes en USD/VES de 2 decimales', () => {
    expect(averageAmount(2.01, 2)).toBe(1.01);
    expect(averageAmount(4.27, 2)).toBe(2.14);
    expect(averageAmount(8.03, 2)).toBe(4.02);
    expect(averageAmount(260, 3)).toBe(86.67);
    expect(averageAmount(36.5, 1)).toBe(36.5);
  });

  /** Oráculo independiente: cociente y resto enteros, empate hacia arriba. */
  function halfUpByRemainder(total: number, n: number): number {
    const q = Math.floor(total / n);
    const r = total - q * n;
    return 2 * r >= n ? q + 1 : q;
  }

  it('propiedad: igual al cociente exacto redondeado (céntimos en ±300000, n en 1..60)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -300_000, max: 300_000 }),
        fc.integer({ min: 1, max: 60 }),
        (total, n) => {
          expect(averageCents(total, n)).toBe(halfUpByRemainder(total, n));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('exhaustivo: todos los netos de 0.00 a 300.00 entre 1..60', () => {
    let bad = 0;
    for (let total = 0; total <= 30_000; total++) {
      for (let n = 1; n <= 60; n++) {
        if (averageCents(total, n) !== halfUpByRemainder(total, n)) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  /** El redondeo con épsilon que tenía el informe de producción (borrado). */
  const oldEpsilon = (x: number) =>
    Math.round((x + Number.EPSILON) * 100) / 100;

  it('propiedad: en sumas y restas de importes de 2 decimales, round2 da lo mismo que el épsilon de antes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (a, b) => {
          const x = a / 100 - b / 100;
          expect(round2(x)).toBe(oldEpsilon(x));
          expect(round2(a / 100 + b / 100)).toBe(oldEpsilon(a / 100 + b / 100));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('round2WithEpsilon ya no existe: el dinero nunca usa Number.EPSILON', () => {
    expect('round2WithEpsilon' in money).toBe(false);
    expect(readFileSync(join(__dirname, 'money.ts'), 'utf8')).not.toMatch(
      /EPSILON/,
    );
  });
});

/**
 * DX-054 (criterio 7): ningún módulo define su propio redondeo de dinero; todos
 * usan `src/shared/money`. Escanea todo `src/modules`, specs incluidos. DX-472:
 * también los `Math.round(x * 100)` sueltos, en varias líneas o en `__fixtures__`
 * (un porcentaje entero es `wholePercent`, de `shared/format`).
 */
describe('guarda: un solo redondeo de dinero', () => {
  const MODULES = join(__dirname, '..', '..', 'modules');
  const OWN_HELPER =
    /\b(?:function|const|let|var)\s+(round2|toCents|fromCents)\b/;
  // Un solo argumento sin `;`: 100 como factor, a cualquier lado del `*`.
  const INLINE_CENTS = /Math\.round\([^;]*?(?:\*\s*100\b|\b100\s*\*)/g;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  it('ningún fichero de src/modules define round2, toCents o fromCents, ni redondea a 2 decimales a mano', () => {
    const offenders = sources(MODULES).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(MODULES, path)}:${i + 1}` }))
        .filter(({ line }) => OWN_HELPER.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('ningún fichero de src/modules multiplica por 100 dentro de un Math.round', () => {
    const offenders = sources(MODULES).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(INLINE_CENTS)].map(
        ([match]) => `${relative(MODULES, path)}  ${match}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('la guarda reconoce las formas de un redondeo a mano', () => {
    const caught = (text: string) => [...text.matchAll(INLINE_CENTS)].length;
    expect(caught('const c = Math.round(x * 100);')).toBe(1);
    expect(caught('Math.round(a.amount*100) / 100')).toBe(1);
    expect(caught('Math.round(100 * x)')).toBe(1);
    expect(caught('Math.round((a + b) * 100)')).toBe(1);
    expect(caught('Math.round(\n  (a + b) *\n    100,\n)')).toBe(1);
    expect(caught('Math.round(x * 10000) / 100')).toBe(0);
    expect(caught('Math.round(x * 1000) / 10;\nconst y = z * 100;')).toBe(0);
  });
});
