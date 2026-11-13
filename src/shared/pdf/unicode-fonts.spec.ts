import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNICODE_FONT_FILES,
  hasUnicodeGlyph,
  unicodeRuns,
} from './unicode-fonts';

const FONTS_DIR = join(__dirname, 'fonts');

/** Los ficheros publicados, sin modificar (ver fonts/README.md). */
const SHA256: Record<string, string> = {
  'NotoSans-Regular.ttf':
    'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  'NotoSans-Bold.ttf':
    '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
  'NotoSansCJKsc-Regular.otf':
    '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
};

/** DX-459 (criterio 4): lo que las fuentes añaden a la imagen, acotado. */
const MAX_FONTS_DIR_BYTES = 20 * 1024 * 1024;

describe('fuentes Unicode del PDF (DX-459)', () => {
  it('son exactamente los ficheros publicados que documenta fonts/README.md', () => {
    expect([...UNICODE_FONT_FILES].sort()).toEqual(Object.keys(SHA256).sort());
    for (const [file, sha] of Object.entries(SHA256)) {
      const bytes = readFileSync(join(FONTS_DIR, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    }
  });

  it('la carpeta cabe en el tope documentado (20 MiB) y lleva la licencia OFL', () => {
    const total = readdirSync(FONTS_DIR).reduce(
      (sum, file) => sum + statSync(join(FONTS_DIR, file)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_FONTS_DIR_BYTES);
    const license = readFileSync(join(FONTS_DIR, 'OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    for (const family of ['latin-greek-cyrillic', 'noto-cjk']) {
      expect(license).toContain(family);
    }
  });

  it('cubren griego, cirílico y CJK (chino, japonés, coreano); no árabe, hebreo ni emoji', () => {
    for (const ch of 'ΖωήЖизнь名前ひらがなカタカナ한국어') {
      expect(hasUnicodeGlyph(ch)).toBe(true);
    }
    // De derecha a izquierda: sin bidi no se pintan (el dominio las niega).
    for (const ch of ['ع', 'ש', '😀']) expect(hasUnicodeGlyph(ch)).toBe(false);
  });

  it('parte una línea en tramos de una fuente sin cortar por espacios o signos', () => {
    const runs = unicodeRuns('Laura 名前、山田 Ζωή 1,5 €', 'regular')!;
    expect(runs.map((r) => r.text)).toEqual([
      'Laura ',
      '名前、山田 ',
      'Ζωή 1,5 €',
    ]);
    expect(runs.map((r) => r.font.postscriptName)).toEqual([
      'NotoSans-Regular',
      'NotoSansCJKsc-Regular',
      'NotoSans-Regular',
    ]);
  });

  it('un carácter que ninguna fuente tiene: null (el renderer no lo pinta)', () => {
    expect(unicodeRuns('Hola 😀', 'regular')).toBeNull();
  });
});
