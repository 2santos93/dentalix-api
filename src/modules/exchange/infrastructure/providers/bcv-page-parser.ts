import { parseCivilDate } from '../../../../shared/time/civil-day';
import { parseEsDecimal } from '../../domain/bcv-rate';

/** Lo que se lee de la portada del BCV. */
export interface BcvPageRates {
  usdVes: number;
  eurVes: number;
  valueDate: string;
}

/** La página no tiene la forma esperada (el BCV la cambió o vino otra cosa). */
export class BcvPageFormatError extends Error {
  constructor(readonly reason: string) {
    super(`Portada del BCV sin el formato esperado: ${reason}`);
    this.name = 'BcvPageFormatError';
  }
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/**
 * El trozo de HTML del elemento con ese `id` (hasta el siguiente `id=`), o
 * null si no está. Los bloques de la tasa no anidan elementos con `id`.
 */
function block(html: string, id: string): string | null {
  const start = new RegExp(`\\sid\\s*=\\s*["']${id}["']`, 'i').exec(html);
  if (!start) return null;
  const rest = html.slice(start.index + start[0].length);
  const next = rest.search(/\sid\s*=\s*["']/i);
  return next === -1 ? rest.slice(0, 4000) : rest.slice(0, next);
}

/** La cifra del bloque `#dolar` o `#euro`: el texto del `<strong>`. */
function rateIn(html: string, id: 'dolar' | 'euro'): number {
  const part = block(html, id);
  if (part === null) throw new BcvPageFormatError(`falta el bloque #${id}`);
  const strong = /<strong\b[^>]*>([^<]*)<\/strong>/i.exec(part);
  if (!strong) throw new BcvPageFormatError(`#${id} sin la cifra`);
  const value = parseEsDecimal(strong[1].replace(/&nbsp;/gi, ' '));
  if (value === null || value <= 0) {
    throw new BcvPageFormatError(`#${id} con una cifra ilegible`);
  }
  return value;
}

/**
 * La «Fecha Valor»: el atributo `content` (ISO, con la zona de Caracas) del
 * elemento que sigue al rótulo o, si no está, su texto («Martes, 24 Noviembre
 * 2026»).
 */
function valueDateIn(html: string): string {
  const label = /Fecha\s+Valor/i.exec(html);
  if (!label) throw new BcvPageFormatError('falta la «Fecha Valor»');
  // Solo el elemento que sigue al rótulo (hasta su primera etiqueta de
  // cierre): otra fecha de la página (las reservas, p. ej.) no cuenta.
  const after = html.slice(label.index + label[0].length);
  const close = after.indexOf('</');
  const near = after.slice(0, close === -1 ? 300 : Math.min(close, 600));
  const iso = /content\s*=\s*["'](\d{4}-\d{2}-\d{2})/i.exec(near);
  if (iso && parseCivilDate(iso[1]) !== null) return iso[1];
  const text = near.replace(/<[^>]*>/g, ' ');
  const spoken =
    /(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i.exec(text);
  const month = spoken ? MONTHS[spoken[2].toLowerCase()] : undefined;
  if (spoken && month) {
    const day = `${spoken[3]}-${String(month).padStart(2, '0')}-${spoken[1].padStart(2, '0')}`;
    if (parseCivilDate(day) !== null) return day;
  }
  throw new BcvPageFormatError('«Fecha Valor» ilegible');
}

/**
 * DX-585: lee la portada de https://www.bcv.org.ve/: bolívares por USD
 * (`#dolar`) y por EUR (`#euro`) en formato es («918,76620000»,
 * «1.011,17949056») y su «Fecha Valor». Cualquier cambio de forma da
 * `BcvPageFormatError` (controlado): nunca una tasa a medias.
 */
export function parseBcvPage(html: string): BcvPageRates {
  return {
    usdVes: rateIn(html, 'dolar'),
    eurVes: rateIn(html, 'euro'),
    valueDate: valueDateIn(html),
  };
}
