import { crc32, deflateRawSync } from 'node:zlib';

/*
 * Constructor mínimo de .xlsx para las pruebas de la importación (DX-107):
 * una hoja, cadenas compartidas o en línea, números y fechas con estilo de
 * fecha. Lo justo para ejercitar `readXlsx` como lo haría un Excel real.
 */

export type XlsxCell = string | number | { date: number } | null;

interface ZipFile {
  name: string;
  data: Buffer;
  store?: boolean;
  /** Tamaño descomprimido que DICE la cabecera (para mentir, como una bomba). */
  declaredSize?: number;
}

/** ZIP mínimo (stored o deflate) para las pruebas. */
export function zip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const body = file.store ? file.data : deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.declaredSize ?? file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.declaredSize ?? file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Libro con UNA hoja; `inline` usa cadenas en línea en vez de compartidas. */
export function buildXlsx(
  rows: readonly (readonly XlsxCell[])[],
  options: { inline?: boolean; sheetPath?: string } = {},
): Buffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sheetPath = options.sheetPath ?? 'worksheets/sheet1.xml';
  const rowXml = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === null) return '';
          if (typeof value === 'number')
            return `<c r="${ref}"><v>${value}</v></c>`;
          if (typeof value === 'object') {
            return `<c r="${ref}" s="1"><v>${value.date}</v></c>`;
          }
          if (options.inline) {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
          }
          let index = sharedIndex.get(value);
          if (index === undefined) {
            index = shared.length;
            shared.push(value);
            sharedIndex.set(value, index);
          }
          return `<c r="${ref}" t="s"><v>${index}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: ZipFile[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Pacientes" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="${sheetPath}"/></Relationships>`,
      ),
    },
    {
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      ),
    },
    {
      name: `xl/${sheetPath}`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${rowXml}</sheetData></worksheet>`,
      ),
    },
  ];
  if (!options.inline) {
    files.push({
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}" count="${shared.length}" uniqueCount="${shared.length}">${shared
          .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
          .join('')}</sst>`,
      ),
    });
  }
  return zip(files);
}
