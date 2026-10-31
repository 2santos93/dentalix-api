import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fromCents, round2, toCents } from './money';

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

/**
 * DX-054 (criterio 7): ningún módulo define su propio redondeo de dinero; todos
 * usan `src/shared/money`. Escanea todo `src/modules`, specs incluidos (salvo `__fixtures__`).
 */
describe('guarda: un solo redondeo de dinero', () => {
  const MODULES = join(__dirname, '..', '..', 'modules');
  const OWN_HELPER =
    /\b(?:function|const|let|var)\s+(round2|toCents|fromCents)\b/;
  const INLINE_ROUND2 = /Math\.round\(\s*[\w.]+\s*\*\s*100\s*\)\s*\/\s*100\b/;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return name === '__fixtures__' ? [] : sources(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  it('ningún fichero de src/modules define round2, toCents o fromCents, ni redondea a 2 decimales a mano', () => {
    const offenders = sources(MODULES).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(MODULES, path)}:${i + 1}` }))
        .filter(({ line }) => OWN_HELPER.test(line) || INLINE_ROUND2.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
