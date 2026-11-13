import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { create, type Font } from 'fontkit';

/**
 * DX-459: las fuentes OFL embebidas (Noto) con las que un PDF pinta texto que
 * las fuentes estándar (WinAnsi) no tienen: griego, cirílico, chino,
 * japonés, coreano. Sin escrituras de derecha a izquierda: sin maquetación
 * bidi, el dominio las niega (y no se distribuye su fuente). Viven en `./fonts` (con su OFL.txt) y nest-cli las copia
 * a `dist` junto a este módulo. Tamaños y criterio: `./fonts/README.md`.
 *
 * Cada fuente se abre la primera vez que hace falta y se queda en memoria
 * (la CJK, 16 MB, solo si algún texto la necesita). pdfkit incrusta en cada
 * PDF un SUBCONJUNTO: solo los glifos usados.
 */
export type PdfFontWeight = 'regular' | 'bold';

const FONTS_DIR = join(__dirname, 'fonts');

interface FontFamily {
  regular: string;
  /** Sin negrita propia (CJK: 16 MB más), la negrita usa la regular. */
  bold: string;
}

/**
 * Orden de preferencia: la primera que tenga el glifo. Noto Sans (latín,
 * griego, cirílico) y Noto Sans CJK SC (todo el CJK
 * unificado: hanzi/kanji/hanja, kana y hangul; con glifos de forma china
 * simplificada cuando un ideograma tiene variantes regionales).
 */
const FAMILIES: readonly FontFamily[] = [
  { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' },
  {
    regular: 'NotoSansCJKsc-Regular.otf',
    bold: 'NotoSansCJKsc-Regular.otf',
  },
];

/** Todos los ficheros de fuente que se distribuyen (para la imagen y CI). */
export const UNICODE_FONT_FILES: readonly string[] = [
  ...new Set(FAMILIES.flatMap((f) => [f.regular, f.bold])),
];

const loaded = new Map<string, Font>();

function open(file: string): Font {
  let font = loaded.get(file);
  if (!font) {
    font = create(readFileSync(join(FONTS_DIR, file)));
    loaded.set(file, font);
  }
  return font;
}

/** La fuente (de las embebidas) que pinta este carácter, o null si ninguna. */
function familyFor(codePoint: number): FontFamily | null {
  // La regular decide: la negrita de cada familia cubre lo mismo.
  return (
    FAMILIES.find((family) =>
      open(family.regular).hasGlyphForCodePoint(codePoint),
    ) ?? null
  );
}

/** ¿Alguna de las fuentes embebidas tiene el glifo de este carácter? */
export function hasUnicodeGlyph(ch: string): boolean {
  const codePoint = ch.codePointAt(0);
  return codePoint !== undefined && familyFor(codePoint) !== null;
}

export interface UnicodeTextRun {
  font: Font;
  text: string;
}

const LETTER = /^\p{L}$/u;

/**
 * Parte UNA línea (sin saltos) en tramos de una sola fuente. Una letra va con
 * la primera fuente que la tiene; lo demás (espacios, signos, cifras, marcas
 * que se combinan con la letra anterior) se queda en la fuente del tramo en
 * curso si la tiene, para no cortar una frase china por un espacio.
 * Devuelve null si algún carácter no está en ninguna fuente.
 */
export function unicodeRuns(
  line: string,
  weight: PdfFontWeight,
): UnicodeTextRun[] | null {
  const runs: { family: FontFamily; text: string }[] = [];
  for (const ch of line) {
    const codePoint = ch.codePointAt(0)!;
    const current = runs.at(-1);
    const family =
      current !== undefined &&
      !LETTER.test(ch) &&
      open(current.family.regular).hasGlyphForCodePoint(codePoint)
        ? current.family
        : familyFor(codePoint);
    if (!family) return null;
    if (current?.family === family) current.text += ch;
    else runs.push({ family, text: ch });
  }
  return runs.map((run) => ({
    font: open(weight === 'bold' ? run.family.bold : run.family.regular),
    text: run.text,
  }));
}

/** La fuente embebida principal (Noto Sans): la de las líneas en blanco. */
export function primaryUnicodeFont(weight: PdfFontWeight): Font {
  return open(weight === 'bold' ? FAMILIES[0].bold : FAMILIES[0].regular);
}
