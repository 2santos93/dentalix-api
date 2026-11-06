import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  amountText,
  fromCents,
  round2,
  round2WithEpsilon,
  roundCents,
  toCents,
} from './money';

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

  it('round2WithEpsilon conserva el redondeo del informe de producción', () => {
    for (const v of [0, 1.005, 100.314999, 2.675, 1234.565, 400000 / 4000]) {
      expect(round2WithEpsilon(v)).toBe(
        Math.round((v + Number.EPSILON) * 100) / 100,
      );
    }
    // Donde difieren de `round2` (empates de coma flotante):
    expect(round2WithEpsilon(1.005)).toBe(1.01);
    expect(round2(1.005)).toBe(1);
    expect(round2WithEpsilon(1.005)).not.toBe(round2(1.005));
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
