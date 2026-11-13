import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * DX-459 (pruebas): huella del CONTENIDO de un PDF de pdfkit comprimido, sin
 * depender de la librería zlib de la plataforma. pdfkit comprime cada flujo
 * con el `deflate` de Node, y su salida cambia entre arquitecturas (zlib con
 * optimizaciones por CPU): los mismos datos dan otros bytes en macOS arm64 y
 * en Linux x64. Aquí cada flujo FlateDecode se sustituye por su contenido
 * descomprimido (sin `/Length`) y se quitan los desplazamientos de la tabla
 * xref, que solo dependen de esas longitudes. Todo lo demás (diccionarios,
 * operadores, fuentes, imágenes, metadatos, /ID) entra en la huella.
 */
export function pdfContentSha256(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const header = /<<\n((?:(?!>>\nstream|endobj)[\s\S])*?)>>\nstream\n/g;
  const parts: Buffer[] = [];
  let from = 0;
  for (let m = header.exec(raw); m; m = header.exec(raw)) {
    const length = Number(/\/Length (\d+)/.exec(m[1])?.[1] ?? NaN);
    if (!/\/Filter \/FlateDecode/.test(m[1]) || Number.isNaN(length)) continue;
    const start = m.index + m[0].length;
    const dict = m[1].replace(/\/Length \d+\n/, '');
    parts.push(
      pdf.subarray(from, m.index),
      Buffer.from(`<<\n${dict}>>\nstream\n`, 'latin1'),
      inflateSync(pdf.subarray(start, start + length)),
    );
    from = start + length;
    header.lastIndex = from;
  }
  const tail = raw
    .slice(from)
    .replace(/\n\d{10} \d{5} [nf] /g, '\n')
    .replace(/startxref\n\d+\n/, 'startxref\n');
  parts.push(Buffer.from(tail, 'latin1'));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}
