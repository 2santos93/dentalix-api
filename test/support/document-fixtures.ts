import { crc32, deflateRawSync } from 'node:zlib';
import { signaturePng } from './png-fixtures';

/**
 * DX-151: ficheros mínimos para probar la detección por CONTENIDO de los
 * documentos del paciente. Los válidos llevan la cabecera real de su formato
 * (lo justo para que un lector la reconozca); los falsos son lo que un
 * atacante o un despiste suben con una etiqueta que miente.
 */

export interface ZipEntry {
  name: string;
  content: string | Buffer;
}

/**
 * ZIP mínimo hecho a mano (sin dependencias): cabecera local + datos
 * deflate por entrada, directorio central y registro de fin (EOCD). Basta
 * para que cualquier lector de ZIP (y nuestro detector) lo recorra.
 */
export function zipFixture(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versión que lo creó
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

export const pdfFixture = (): Buffer =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n' +
      'trailer << /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );

/** SOI + APP0 JFIF + EOI. */
export const jpegFixture = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);

/** PNG real (decodificable) del generador de firmas. */
export const pngFixture = (): Buffer => signaturePng(8, 8);

/** Caja `ftyp` de un HEIC: marca principal `heic`, compatibles mif1/heic. */
export function heicFixture(brand = 'heic'): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brand, 8, 'latin1');
  box.writeUInt32BE(0, 12);
  box.write('mif1', 16, 'latin1');
  box.write('heic', 20, 'latin1');
  return Buffer.concat([box, Buffer.alloc(16)]);
}

export const docxFixture = (): Buffer =>
  zipFixture([
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML },
    {
      name: 'word/document.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Informe</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);

/** Preámbulo de 128 bytes + `DICM` + un elemento del grupo 0002. */
export function dicomFixture(): Buffer {
  const element = Buffer.alloc(12);
  element.writeUInt16LE(0x0002, 0);
  element.writeUInt16LE(0x0000, 2);
  element.write('UL', 4, 'latin1');
  element.writeUInt16LE(4, 6);
  element.writeUInt32LE(0, 8);
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM', 'latin1'),
    element,
  ]);
}

// --- Falsos -----------------------------------------------------------------

export const svgFake = (): Buffer =>
  Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );

export const htmlFake = (): Buffer =>
  Buffer.from(
    '<!DOCTYPE html><html><body><script>fetch("/x")</script></body></html>',
  );

export const emlFake = (): Buffer =>
  Buffer.from(
    'From: a@b.c\r\nTo: d@e.f\r\nSubject: Radiografía\r\nContent-Type: text/html\r\n\r\n<b>hola</b>\r\n',
  );

export const textFake = (): Buffer => Buffer.from('notas del paciente\n');

/** Un ZIP de Office que NO es Word (un Excel): no está en la lista blanca. */
export const xlsxLikeZipFake = (): Buffer =>
  zipFixture([
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
  ]);

/**
 * ZIP cuyo CONTENIDO menciona `word/document.xml` pero sin esa entrada en el
 * directorio central: el detector mira nombres de entradas, no bytes sueltos.
 */
export const zipMentioningDocxFake = (): Buffer =>
  zipFixture([{ name: 'notas.txt', content: 'ver word/document.xml' }]);

/** PNG de verdad que llega como `informe.pdf` / `application/pdf`. */
export const pngRenamedAsPdf = () => ({
  bytes: pngFixture(),
  originalName: 'informe.pdf',
  mimeType: 'application/pdf',
});
