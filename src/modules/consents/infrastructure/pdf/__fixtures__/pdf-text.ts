import { inflateSync } from 'node:zlib';

/**
 * DX-459 (pruebas): extrae el texto que pinta un PDF de pdfkit (comprimido o
 * no: los flujos FlateDecode se descomprimen antes), como haría un lector:
 * cada operador `TJ` se decodifica con su fuente (`Tf`). Una fuente estándar escribe bytes WinAnsi; una
 * embebida (Type0, Identity-H) escribe ids de glifo de 2 bytes que su CMap
 * `ToUnicode` traduce. Los fragmentos a la misma altura forman una línea.
 */

/** 0x80–0x9F de WinAnsi que se usan en las pruebas. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€',
  0x93: '“',
  0x94: '”',
  0x97: '—',
};

export interface PdfFontInfo {
  /** Nombre del recurso en el contenido (`F2`). */
  resource: string;
  baseFont: string;
  /** Ids de glifo → texto, de su `ToUnicode` (solo las embebidas). */
  toUnicode: Map<number, string> | null;
}

/**
 * El PDF como texto latin1 con los flujos FlateDecode de contenido y de los
 * CMap ya descomprimidos (pdfkit escribe `/Length` directo). Los binarios
 * (ficheros de fuente, imágenes, adjuntos: llevan `/Length1` o `/Subtype`) se
 * dejan como están para no confundir sus bytes con operadores.
 */
function readable(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  let from = 0;
  const header = /<<\n((?:(?!>>\nstream|endobj)[\s\S])*?)>>\nstream\n/g;
  for (let m = header.exec(raw); m; m = header.exec(raw)) {
    const start = m.index + m[0].length;
    const length = Number(/\/Length (\d+)/.exec(m[1])?.[1] ?? NaN);
    const binary = /\/Length1 |\/Subtype /.test(m[1]);
    if (
      binary ||
      !/\/Filter \/FlateDecode/.test(m[1]) ||
      Number.isNaN(length)
    ) {
      continue;
    }
    const data = inflateSync(pdf.subarray(start, start + length));
    out += raw.slice(from, start) + data.toString('latin1');
    from = start + length;
    header.lastIndex = from;
  }
  return out + raw.slice(from);
}

function objects(raw: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const m of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    map.set(Number(m[1]), m[2]);
  }
  return map;
}

function hexToString(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    units.push(parseInt(hex.slice(i, i + 4), 16));
  }
  return String.fromCharCode(...units);
}

function parseToUnicode(stream: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const m of stream.matchAll(
    /<([0-9a-f]+)> <([0-9a-f]+)> \[([^\]]*)\]/gi,
  )) {
    const start = parseInt(m[1], 16);
    const values = [...m[3].matchAll(/<([0-9a-f ]+)>/gi)].map((v) =>
      hexToString(v[1].replace(/ /g, '')),
    );
    values.forEach((text, i) => map.set(start + i, text));
  }
  return map;
}

/** Las fuentes que usa el PDF, por su nombre de recurso. */
export function pdfFonts(pdf: Buffer): Map<string, PdfFontInfo> {
  const raw = readable(pdf);
  const objs = objects(raw);
  const fonts = new Map<string, PdfFontInfo>();
  for (const block of raw.matchAll(/\/Font <<\n([\s\S]*?)>>/g)) {
    for (const ref of block[1].matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const dict = objs.get(Number(ref[2])) ?? '';
      const baseFont = /\/BaseFont \/(\S+)/.exec(dict)?.[1] ?? '';
      const toUnicodeRef = /\/ToUnicode (\d+) 0 R/.exec(dict)?.[1];
      const stream = toUnicodeRef ? objs.get(Number(toUnicodeRef)) : undefined;
      fonts.set(ref[1], {
        resource: ref[1],
        baseFont,
        toUnicode: stream ? parseToUnicode(stream) : null,
      });
    }
  }
  return fonts;
}

function decode(hex: string, font: PdfFontInfo | undefined): string {
  if (font?.toUnicode) {
    let out = '';
    for (let i = 0; i < hex.length; i += 4) {
      out += font.toUnicode.get(parseInt(hex.slice(i, i + 4), 16)) ?? '�';
    }
    return out;
  }
  return [...Buffer.from(hex, 'hex')]
    .map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b))
    .join('');
}

/** Las líneas pintadas, en orden, con el texto decodificado. */
export function pdfTextLines(pdf: Buffer): string[] {
  const raw = readable(pdf);
  const fonts = pdfFonts(pdf);
  const lines: { y: number; text: string }[] = [];
  let font: PdfFontInfo | undefined;
  let y = Number.NaN;
  let lineY = Number.NaN;
  for (const op of raw.matchAll(
    /1 0 0 1 [\d.-]+ ([\d.-]+) Tm|\/(F\d+) [\d.]+ Tf|\[([^\]]*)\] TJ|(BT)/g,
  )) {
    if (op[1] !== undefined) y = Number(op[1]);
    else if (op[2] !== undefined) font = fonts.get(op[2]);
    else if (op[3] !== undefined) {
      const text = [...op[3].matchAll(/<([0-9a-f]*)>/g)]
        .map((hex) => decode(hex[1], font))
        .join('');
      // Los tramos de una misma línea (otra fuente, otra línea base) van juntos.
      if (lines.length > 0 && Math.abs(y - lineY) < 4) {
        lines[lines.length - 1].text += text;
      } else {
        lines.push({ y, text });
        lineY = y;
      }
    } else if (op[4] !== undefined) {
      y = Number.NaN;
    }
  }
  return lines.map((line) => line.text);
}
