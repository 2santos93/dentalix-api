import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNICODE_FONT_FILES,
  hasUnicodeGlyph,
  unicodeRuns,
} from './unicode-fonts';

const FONTS_DIR = join(__dirname, 'fonts');

/** Los ficheros versionados (ver fonts/README.md: origen y subconjunto). */
const SHA256: Record<string, string> = {
  'NotoSans-Regular.ttf':
    'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  'NotoSans-Bold.ttf':
    '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
  'NotoSansCJKsc-Regular-subset.otf':
    'd6fd3ec4bfd84f671a5048b830ee90a2d671888e96bcfa0d434c73a26ae36f40',
};

/** DX-459 (criterio 4): lo que las fuentes añaden a la imagen, acotado. */
const MAX_FONTS_DIR_BYTES = 10 * 1024 * 1024;

describe('fuentes Unicode del PDF (DX-459)', () => {
  it('son exactamente los ficheros que documenta fonts/README.md', () => {
    expect([...UNICODE_FONT_FILES].sort()).toEqual(Object.keys(SHA256).sort());
    for (const [file, sha] of Object.entries(SHA256)) {
      const bytes = readFileSync(join(FONTS_DIR, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    }
  });

  it('la carpeta cabe en el tope documentado (10 MiB) y lleva la licencia OFL', () => {
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

  it('el subconjunto CJK: GB2312, JIS X 0208, Big5 nivel 1 y todo el hangul; el hueco conocido, fuera', () => {
    // 臺灣 (Big5-1), 山田花子 y 渋 (JIS), 同意书 (GB2312), 뷁 (fuera de KS X 1001).
    for (const ch of '臺灣山田花子渋同意书뷁한ひカ、。（）') {
      expect(hasUnicodeGlyph(ch)).toBe(true);
    }
    // Nombres de pila fuera de GB2312/JIS/Big5-1, 髙 de 髙橋, ext. A y B.
    for (const ch of ['堃', '喆', '赟', '髙', '䶵', '𠀀']) {
      expect(hasUnicodeGlyph(ch)).toBe(false);
    }
  });

  it('parte una línea en tramos de una fuente sin cortar por espacios o signos', () => {
    const runs = unicodeRuns('Laura 名前、山田 Ζωή 1,5 €', 'regular')!;
    expect(runs.map((r) => r.text)).toEqual([
      'Laura ',
      // El subconjunto CJK no lleva ASCII: el espacio va con Noto Sans.
      '名前、山田',
      ' Ζωή 1,5 €',
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
