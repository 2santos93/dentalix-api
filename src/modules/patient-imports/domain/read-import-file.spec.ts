import {
  decodeCsv,
  detectDelimiter,
  parseCsv,
  parseCsvRecords,
} from './csv-parser';
import {
  EXTENSION_MISMATCH_MESSAGE,
  LEGACY_XLS_MESSAGE,
  NO_ROWS_MESSAGE,
  UNREADABLE_MESSAGE,
  UNSUPPORTED_EXTENSION_MESSAGE,
  readImportFile,
} from './read-import-file';
import {
  ImportFileError,
  MAX_COLUMNS,
  MAX_PHYSICAL_ROWS,
  toTable,
  type RawRecord,
} from './tabular-file';
import {
  MAX_XLSX_TOTAL_BYTES,
  decodeXmlText,
  excelSerialToDate,
  readXlsx,
} from './xlsx-reader';
import { buildXlsx, zip } from './__fixtures__/xlsx-builder';
import { TOO_MANY_ROWS_MESSAGE } from './import-fields';

const csvBytes = (text: string, encoding: BufferEncoding = 'utf8') =>
  Buffer.from(text, encoding);

const WB =
  '<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>';
const RELS =
  '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';

/** Libro a mano con la hoja tal cual (para XML raro o malicioso). */
function rawBook(
  sheet: string,
  extra: { name: string; data: Buffer }[] = [],
  store = false,
): Buffer {
  return zip([
    { name: 'xl/workbook.xml', data: Buffer.from(WB) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet), store },
    ...extra,
  ]);
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

async function records(bytes: Buffer): Promise<RawRecord[]> {
  return [...(await readXlsx(bytes))].filter((r) =>
    r.cells.some((c) => c !== ''),
  );
}

describe('CSV (DX-107)', () => {
  it('detecta UTF-8 con y sin BOM y Windows-1252 (Latin-1)', () => {
    expect(decodeCsv(csvBytes('﻿nombres\nAna')).text).toBe('nombres\nAna');
    expect(decodeCsv(csvBytes('nombres\nMaría')).encoding).toBe('utf-8');
    const latin = Buffer.from([0x4d, 0x61, 0x72, 0xed, 0x61, 0x20, 0x80]); // «María €»
    const decoded = decodeCsv(latin);
    expect(decoded.encoding).toBe('windows-1252');
    expect(decoded.text).toBe('María €');
  });

  it('lee UTF-16 LE con BOM («Texto Unicode» de Excel)', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('nombres\tapellidos\nAna\tPérez', 'utf16le'),
    ]);
    const parsed = parseCsv(bytes);
    expect(parsed.encoding).toBe('utf-16le');
    expect(parsed.delimiter).toBe('\t');
    expect([...parsed.records][1].cells).toEqual(['Ana', 'Pérez']);
  });

  it('rechaza un binario que no es texto', () => {
    expect(() => decodeCsv(Buffer.from([0x41, 0x00, 0x42]))).toThrow(
      ImportFileError,
    );
  });

  it('elige el separador de las primeras líneas: «;» (Excel en español), «,» o tabulador', () => {
    expect(detectDelimiter('nombres;apellidos;documento\nA,B;C;D')).toBe(';');
    expect(detectDelimiter('nombres,apellidos\nA;B,C')).toBe(',');
    expect(detectDelimiter('"a;b",c,d\n')).toBe(',');
    expect(detectDelimiter('solo')).toBe(',');
    // Un título sin separadores encima de la cabecera no decide.
    expect(
      detectDelimiter('Pacientes 2026\nnombres;apellidos;doc\nA;B;C'),
    ).toBe(';');
  });

  it('respeta la pista «sep=» de Excel y numera las filas como la hoja', () => {
    const parsed = parseCsv(csvBytes('sep=;\nnombres;apellidos\nAna;Pérez\n'));
    expect(parsed.delimiter).toBe(';');
    expect([...parsed.records]).toEqual([
      { rowNumber: 2, cells: ['nombres', 'apellidos'] },
      { rowNumber: 3, cells: ['Ana', 'Pérez'] },
    ]);
  });

  it('RFC 4180: comillas, comillas dobladas, saltos de línea dentro y CRLF', () => {
    expect(parseCsvRecords('a,"b ""c"", d","e\r\nf"\r\n1,2,3', ',')).toEqual([
      ['a', 'b "c", d', 'e\r\nf'],
      ['1', '2', '3'],
    ]);
  });

  it('no guarda más de 100 campos por registro: lo que sobra solo se anota', () => {
    const [record] = [...parseCsv(csvBytes(';'.repeat(500_000) + 'x')).records];
    expect(record.cells).toHaveLength(MAX_COLUMNS);
    expect(record.overflow).toBe(true);
  });

  it('una comilla sin cerrar no se vuelve cuadrática ni guarda celdas enormes', () => {
    const started = Date.now();
    const [, record] = [
      ...parseCsv(csvBytes(`a,b\n"${'x'.repeat(4_000_000)}`)).records,
    ];
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(record.cells[0].length).toBeLessThanOrEqual(10_000);
  });
});

describe('TableBuilder / toTable', () => {
  const rows = (cells: string[][]) =>
    cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));

  it('ignora filas vacías, recorta, rellena y conserva el número de fila', () => {
    const table = toTable(
      rows([
        ['nombres ', 'apellidos', ''],
        ['', '', ''],
        [' Ana', 'Pérez'],
      ]),
    );
    expect(table.headers).toEqual(['nombres', 'apellidos']);
    expect(table.rows).toEqual([{ rowNumber: 3, cells: ['Ana', 'Pérez'] }]);
  });

  it('un título de una celda encima de la cabecera se salta', () => {
    const table = toTable(
      rows([
        ['Listado de pacientes'],
        [],
        ['nombres', 'apellidos'],
        ['Ana', 'Pérez'],
      ]),
    );
    expect(table.headers).toEqual(['nombres', 'apellidos']);
    expect(table.rows).toEqual([{ rowNumber: 4, cells: ['Ana', 'Pérez'] }]);
  });

  it('una fila con algo escrito más allá de la cabecera queda marcada (error de fila)', () => {
    const table = toTable([
      { rowNumber: 1, cells: ['nombres', 'apellidos'] },
      { rowNumber: 2, cells: ['Ana', 'Pérez', 'Calle 1'] },
      { rowNumber: 3, cells: ['Luis', 'Gil', ''] },
      { rowNumber: 4, cells: ['Eva', 'Paz'], overflow: true },
    ]);
    expect(table.rows.map((r) => [r.rowNumber, r.extraCells ?? false])).toEqual(
      [
        [2, true],
        [3, false],
        [4, true],
      ],
    );
  });

  it('rechaza cabeceras repetidas, más de 10.000 filas con datos y demasiadas filas físicas', () => {
    expect(() => toTable(rows([['a', 'A']]))).toThrow(/aparece dos veces/);
    const many = [
      ['a', 'b'],
      ...Array.from({ length: 10_001 }, (_, i) => [`x${i}`, 'y']),
    ];
    expect(() => toTable(rows(many))).toThrow(TOO_MANY_ROWS_MESSAGE);
    const exact = [
      ['a', 'b'],
      ...Array.from({ length: 10_000 }, (_, i) => [`x${i}`, 'y']),
    ];
    expect(toTable(rows(exact)).rows).toHaveLength(10_000);
    const blanks = Array.from(
      { length: MAX_PHYSICAL_ROWS + 1 },
      () => [] as string[],
    );
    expect(() => toTable(rows(blanks))).toThrow(
      /filas \(contando las vacías\)/,
    );
  });
});

describe('XLSX', () => {
  it('lee cadenas compartidas, en línea, números sin notación científica y fechas', async () => {
    const book = buildXlsx([
      ['nombres', 'documento', 'nacimiento', 'telefono'],
      ['Ana & Eva <x>', 1020304050, { date: 32874 }, null],
      ['Luis', 12345678901, { date: 45000 }, 3101234567],
    ]);
    expect(await records(book)).toEqual([
      {
        rowNumber: 1,
        cells: ['nombres', 'documento', 'nacimiento', 'telefono'],
      },
      { rowNumber: 2, cells: ['Ana & Eva <x>', '1020304050', '1990-01-01'] },
      {
        rowNumber: 3,
        cells: ['Luis', '12345678901', '2023-03-15', '3101234567'],
      },
    ]);
    const inlined = await records(
      buildXlsx(
        [
          ['a', 'b'],
          ['ñ', 'é'],
        ],
        { inline: true },
      ),
    );
    expect(inlined[1].cells).toEqual(['ñ', 'é']);
  });

  it('sigue la relación del libro hasta la hoja aunque no sea sheet1.xml', async () => {
    const book = buildXlsx(
      [
        ['a', 'z'],
        ['b', 'y'],
      ],
      { sheetPath: 'worksheets/hoja-pacientes.xml' },
    );
    expect((await records(book))[1].cells).toEqual(['b', 'y']);
  });

  it('prefijos de espacio de nombres, comillas simples y celdas de error vacías', async () => {
    const sheet =
      "<x:worksheet xmlns:x='m'><x:sheetData><x:row r='1'><x:c r='A1' t='inlineStr'><x:is><x:t>nombres</x:t></x:is></x:c>" +
      "<x:c r='B1' t='inlineStr'><x:is><x:t>doc</x:t></x:is></x:c></x:row>" +
      "<x:row r='2'><x:c r='A2' t='str'><x:v>Ana</x:v></x:c><x:c r='B2' t='e'><x:v>#N/A</x:v></x:c></x:row></x:sheetData></x:worksheet>";
    expect(await records(rawBook(sheet))).toEqual([
      { rowNumber: 1, cells: ['nombres', 'doc'] },
      { rowNumber: 2, cells: ['Ana', ''] },
    ]);
  });

  it('una etiqueta sin cerrar es un error del fichero, en tiempo lineal', async () => {
    const started = Date.now();
    const book = rawBook('<sheetData>' + '<row>'.repeat(1_000_000), [], true);
    await expect(readXlsx(book).then((r) => [...r])).rejects.toThrow(
      ImportFileError,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('número de fila: entero de 1 a 1.048.576 y creciente; si no, el siguiente', async () => {
    const sheet =
      `<sheetData><row r="1">${inline('A1', 'nombres')}${inline('B1', 'doc')}</row>` +
      `<row r="abc">${inline('A2', 'x')}</row><row r="99999999">${inline('A3', 'y')}</row>` +
      `<row r="20000">${inline('A4', 'z')}</row><row r="7">${inline('A5', 'w')}</row></sheetData>`;
    expect((await records(rawBook(sheet))).map((r) => r.rowNumber)).toEqual([
      1, 2, 3, 20000, 20001,
    ]);
  });

  it('una celda en la columna XFD no reserva 16.384 celdas: se anota como desbordada', async () => {
    const one = '<row><c r="XFD1" t="inlineStr"><is><t>1</t></is></c></row>';
    const all = [
      ...(await readXlsx(
        rawBook(`<sheetData>${one.repeat(1000)}</sheetData>`),
      )),
    ];
    expect(all[0]).toEqual({ rowNumber: 1, cells: [], overflow: true });
  });

  it('serie de Excel → fecha civil; fuera de rango (1e12) no revienta', () => {
    expect(excelSerialToDate(1)).toBe('1900-01-01');
    expect(excelSerialToDate(59)).toBe('1900-02-28');
    expect(excelSerialToDate(61)).toBe('1900-03-01');
    expect(excelSerialToDate(25569)).toBe('1970-01-01');
    expect(excelSerialToDate(0, true)).toBeNull();
    expect(excelSerialToDate(1, true)).toBe('1904-01-02');
    expect(excelSerialToDate(2_958_465)).toBe('9999-12-31');
    expect(excelSerialToDate(2_958_466)).toBeNull();
    expect(excelSerialToDate(1e12)).toBeNull();
  });

  it('una fecha enorme con estilo de fecha sale como número, no como 500', async () => {
    const styles =
      '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const sheet = `<sheetData><row r="1">${inline('A1', 'nombres')}${inline('B1', 'nac')}</row><row r="2">${inline('A2', 'Ana')}<c r="B2" s="1"><v>1e12</v></c></row></sheetData>`;
    const rows = await records(
      rawBook(sheet, [{ name: 'xl/styles.xml', data: Buffer.from(styles) }]),
    );
    expect(rows[1].cells).toEqual(['Ana', '1000000000000']);
  });

  it('decodifica entidades y el escape _xHHHH_ sin expandir DTD', () => {
    expect(decodeXmlText('a&amp;b&#233;&#x41;_x000D_')).toBe('a&béA\r');
    expect(decodeXmlText('&ent;')).toBe('&ent;');
  });

  it('zip bomb: corta por el tope TOTAL aunque la cabecera mienta sobre el tamaño', async () => {
    const big = Buffer.alloc(MAX_XLSX_TOTAL_BYTES + 1024, 0x20);
    const bomb = zip([
      { name: 'xl/workbook.xml', data: Buffer.from(WB) },
      { name: 'xl/worksheets/sheet1.xml', data: big, declaredSize: 10 },
    ]);
    expect(bomb.length).toBeLessThan(MAX_XLSX_TOTAL_BYTES / 100);
    await expect(readXlsx(bomb)).rejects.toThrow(/demasiado grande/);
    // Dos partes de 20 MB: cada una cabe sola, juntas no.
    const half = Buffer.alloc(20 * 1024 * 1024, 0x20);
    const twoParts = zip([
      { name: 'xl/workbook.xml', data: Buffer.from(WB) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS) },
      { name: 'xl/worksheets/sheet1.xml', data: half, declaredSize: 10 },
      { name: 'xl/sharedStrings.xml', data: half, declaredSize: 10 },
    ]);
    await expect(readXlsx(twoParts)).rejects.toThrow(/demasiado grande/);
  });

  it('un ZIP que no es un libro es un error del fichero', async () => {
    await expect(
      readXlsx(zip([{ name: 'a.txt', data: Buffer.from('hola') }])),
    ).rejects.toThrow(ImportFileError);
    await expect(readXlsx(Buffer.from('PK\u0003\u0004basura'))).rejects.toThrow(
      ImportFileError,
    );
  });
});

describe('readImportFile', () => {
  const xls = Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
  ]);

  it('decide el formato por el contenido y exige que cuadre con la extensión', async () => {
    const csv = await readImportFile(
      csvBytes('nombres;apellidos\nAna;Pérez'),
      'pacientes.csv',
    );
    expect(csv).toMatchObject({
      format: 'CSV',
      delimiter: ';',
      encoding: 'utf-8',
    });
    const book = await readImportFile(
      buildXlsx([
        ['nombres', 'doc'],
        ['Ana', '1'],
      ]),
      'Pacientes.XLSX',
    );
    expect(book.format).toBe('XLSX');
    await expect(
      readImportFile(
        buildXlsx([
          ['a', 'z'],
          ['b', 'y'],
        ]),
        'p.csv',
      ),
    ).rejects.toThrow(EXTENSION_MISMATCH_MESSAGE);
    await expect(readImportFile(csvBytes('a\nb'), 'p.xlsx')).rejects.toThrow(
      EXTENSION_MISMATCH_MESSAGE,
    );
    await expect(readImportFile(xls, 'p.xls')).rejects.toThrow(
      LEGACY_XLS_MESSAGE,
    );
    await expect(readImportFile(xls, 'p.xlsx')).rejects.toThrow(
      LEGACY_XLS_MESSAGE,
    );
    await expect(readImportFile(csvBytes('a\nb'), 'p.pdf')).rejects.toThrow(
      UNSUPPORTED_EXTENSION_MESSAGE,
    );
    await expect(
      readImportFile(csvBytes('nombres;doc\n\n'), 'p.csv'),
    ).rejects.toThrow(NO_ROWS_MESSAGE);
  });

  it('CSV de 5 MB de saltos de línea o de «;»: error claro sin agotar la memoria', async () => {
    const before = process.memoryUsage().rss;
    const newlines = Buffer.alloc(5 * 1024 * 1024 - 10, 0x0a);
    newlines.write('a,b\n', 0);
    await expect(readImportFile(newlines, 'x.csv')).rejects.toThrow(
      ImportFileError,
    );
    const semis = Buffer.alloc(5 * 1024 * 1024 - 10, 0x3b);
    semis.write('a\n', 0);
    await expect(readImportFile(semis, 'x.csv')).rejects.toThrow(
      ImportFileError,
    );
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
  });

  it('XLSX de filas vacías comprimidas: no guarda filas ni pasa el tope de memoria', async () => {
    const one = '<row><c/></row>';
    const book = rawBook(
      '<sheetData>' +
        one.repeat(Math.floor((20 * 1024 * 1024) / one.length)) +
        '</sheetData>',
    );
    await expect(readImportFile(book, 'x.xlsx')).rejects.toThrow(
      /filas \(contando las vacías\)|no tiene cabecera/,
    );
  });

  it('un fallo inesperado del lector es un 400 genérico en español, nunca un 500', async () => {
    const book = buildXlsx([
      ['nombres', 'doc'],
      ['Ana', '1'],
    ]);
    // Un error que no es del fichero dentro del lector (aquí, simulado).
    const spy = jest
      .spyOn(Buffer.prototype, 'toString')
      .mockImplementationOnce(() => {
        throw new TypeError('boom');
      });
    try {
      const err = await readImportFile(book, 'x.xlsx').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as Error).message).toBe(UNREADABLE_MESSAGE);
    } finally {
      spy.mockRestore();
    }
  });
});
