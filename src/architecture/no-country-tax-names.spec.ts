import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-516: Dentalix no fija ningún tributo de un país. Los ajustes por medio
 * de pago son genéricos (impuesto, recargo o descuento) y la etiqueta la
 * escribe la clínica. Esta guarda recorre TODO `src/` (código, comentarios,
 * pruebas y JSON) y falla si una línea nombra por su sigla un tributo o una
 * autoridad tributaria de un país. Las siglas se arman por partes para que
 * este fichero no se delate a sí mismo; la autoprueba fija que cada una se
 * detecta y que el texto genérico pasa.
 */
const SRC = join(__dirname, '..');
const SELF = relative(SRC, __filename).split(sep).join('/');

/** Siglas de tributos y de autoridades tributarias de un país (mayúsculas). */
export const COUNTRY_TAX_TERMS: readonly string[] = [
  // Tributos sobre las transacciones o el consumo.
  'IG' + 'TF',
  'IT' + 'BIS',
  'IT' + 'BMS',
  'IG' + 'V',
  'IE' + 'PS',
  'IC' + 'MS',
  'CO' + 'FINS',
  'GM' + 'F',
  'IS' + 'LR',
  'IR' + 'PF',
  'IV' + 'A',
  'VA' + 'T',
  'GS' + 'T',
  // Autoridades tributarias.
  'SEN' + 'IAT',
  'SUN' + 'AT',
  'DI' + 'AN',
  'AF' + 'IP',
  'HM' + 'RC',
];

const COUNTRY_TAX = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${COUNTRY_TAX_TERMS.join('|')})(?![\p{L}\p{N}_])` +
    String.raw`|\b4\s*x\s*1000\b|\bcuatro\s+por\s+mil\b`,
  'u',
);

export function namesCountryTax(line: string): boolean {
  return COUNTRY_TAX.test(line);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|json)$/.test(entry.name) ? [path] : [];
  });
}

describe('sin tributos de un país en src/ (DX-516)', () => {
  it('ninguna línea de src/ nombra un tributo o una autoridad tributaria de un país', () => {
    const files = sourceFiles(SRC).filter(
      (path) => relative(SRC, path).split(sep).join('/') !== SELF,
    );
    expect(files.length).toBeGreaterThan(500);
    const hits = files.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          namesCountryTax(line)
            ? [`${relative(SRC, path)}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });

  it('la guarda detecta cada sigla y deja pasar el texto genérico', () => {
    for (const term of COUNTRY_TAX_TERMS) {
      expect({ term, caught: namesCountryTax(`label: '${term} 3 %'`) }).toEqual(
        { term, caught: true },
      );
    }
    expect(namesCountryTax('el 4x1000 del banco')).toBe(true);
    expect(namesCountryTax('cuatro por mil')).toBe(true);
    for (const text of [
      'Impuesto 3 %',
      'Recargo por tarjeta',
      'Descuento en efectivo',
      'TAX',
      'SURCHARGE',
      'DISCOUNT',
      'private',
      'diana',
      'Divan',
      'navigateTo',
    ]) {
      expect({ text, caught: namesCountryTax(text) }).toEqual({
        text,
        caught: false,
      });
    }
  });
});
