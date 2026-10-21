import { deflateRawSync } from 'node:zlib';
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
  UNSUPPORTED_EXTENSION_MESSAGE,
  readImportFile,
} from './read-import-file';
import { ImportFileError, toTable } from './tabular-file';
import {
  MAX_XLSX_PART_BYTES,
  decodeXmlText,
  excelSerialToDate,
  readXlsx,
} from './xlsx-reader';
import { buildXlsx, zip } from './__fixtures__/xlsx-builder';
import { TOO_MANY_ROWS_MESSAGE } from './import-fields';

const csvBytes = (text: string, encoding: BufferEncoding = 'utf8') =>
  Buffer.from(text, encoding);

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
    expect(parsed.records[1].cells).toEqual(['Ana', 'Pérez']);
  });

  it('rechaza un binario que no es texto', () => {
    expect(() => decodeCsv(Buffer.from([0x41, 0x00, 0x42]))).toThrow(
      ImportFileError,
    );
  });

  it('elige el separador de la cabecera: «;» (Excel en español), «,» o tabulador', () => {
    expect(detectDelimiter('nombres;apellidos;documento\nA,B;C;D')).toBe(';');
    expect(detectDelimiter('nombres,apellidos\nA;B,C')).toBe(',');
    expect(detectDelimiter('"a;b",c,d\n')).toBe(',');
    expect(detectDelimiter('solo')).toBe(',');
  });

  it('respeta la pista «sep=» de Excel y numera las filas como la hoja', () => {
    const parsed = parseCsv(csvBytes('sep=;\nnombres;apellidos\nAna;Pérez\n'));
    expect(parsed.delimiter).toBe(';');
    expect(parsed.records).toEqual([
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
});

describe('toTable', () => {
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

  it('rechaza cabeceras repetidas y más de 10.000 filas', () => {
    expect(() => toTable(rows([['a', 'A']]))).toThrow(/aparece dos veces/);
    const many = [
      ['a'],
      ...Array.from({ length: 10_001 }, (_, i) => [`x${i}`]),
    ];
    expect(() => toTable(rows(many))).toThrow(TOO_MANY_ROWS_MESSAGE);
    const exact = [
      ['a'],
      ...Array.from({ length: 10_000 }, (_, i) => [`x${i}`]),
    ];
    expect(toTable(rows(exact)).rows).toHaveLength(10_000);
  });
});

describe('XLSX', () => {
  it('lee cadenas compartidas, en línea, números sin notación científica y fechas', () => {
    const book = buildXlsx([
      ['nombres', 'documento', 'nacimiento', 'telefono'],
      ['Ana & Eva <x>', 1020304050, { date: 32874 }, null],
      ['Luis', 12345678901, { date: 45000 }, 3101234567],
    ]);
    const sheet = readXlsx(book);
    expect(sheet.records).toEqual([
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
    const inline = readXlsx(
      buildXlsx(
        [
          ['a', 'b'],
          ['ñ', 'é'],
        ],
        { inline: true },
      ),
    );
    expect(inline.records[1].cells).toEqual(['ñ', 'é']);
  });

  it('sigue la relación del libro hasta la hoja aunque no sea sheet1.xml', () => {
    const book = buildXlsx([['a'], ['b']], {
      sheetPath: 'worksheets/hoja-pacientes.xml',
    });
    expect(readXlsx(book).records[1].cells).toEqual(['b']);
  });

  it('serie de Excel → fecha civil (incluido el 29/02/1900 que no existió)', () => {
    expect(excelSerialToDate(1)).toBe('1900-01-01');
    expect(excelSerialToDate(59)).toBe('1900-02-28');
    expect(excelSerialToDate(61)).toBe('1900-03-01');
    expect(excelSerialToDate(25569)).toBe('1970-01-01');
    expect(excelSerialToDate(0, true)).toBeNull();
    expect(excelSerialToDate(1, true)).toBe('1904-01-02');
  });

  it('decodifica entidades y el escape _xHHHH_ sin expandir DTD', () => {
    expect(decodeXmlText('a&amp;b&#233;&#x41;_x000D_')).toBe('a&béA\r');
    expect(decodeXmlText('&ent;')).toBe('&ent;');
  });

  it('corta una «zip bomb» por el tope de salida', () => {
    const big = Buffer.alloc(MAX_XLSX_PART_BYTES + 1024, 0x20);
    const bomb = zip([
      {
        name: 'xl/workbook.xml',
        data: Buffer.from(
          '<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>',
        ),
      },
      { name: 'xl/worksheets/sheet1.xml', data: big },
    ]);
    expect(bomb.length).toBeLessThan(MAX_XLSX_PART_BYTES / 100);
    expect(() => readXlsx(bomb)).toThrow(/demasiado grande/);
    expect(deflateRawSync(Buffer.from('x')).length).toBeGreaterThan(0);
  });

  it('un ZIP que no es un libro es un error del fichero', () => {
    expect(() =>
      readXlsx(zip([{ name: 'a.txt', data: Buffer.from('hola') }])),
    ).toThrow(ImportFileError);
    expect(() => readXlsx(Buffer.from('PK\u0003\u0004basura'))).toThrow(
      ImportFileError,
    );
  });
});

describe('readImportFile', () => {
  const xls = Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
  ]);

  it('decide el formato por el contenido y exige que cuadre con la extensión', () => {
    const csv = readImportFile(
      csvBytes('nombres;apellidos\nAna;Pérez'),
      'pacientes.csv',
    );
    expect(csv).toMatchObject({
      format: 'CSV',
      delimiter: ';',
      encoding: 'utf-8',
    });
    const book = readImportFile(
      buildXlsx([['nombres'], ['Ana']]),
      'Pacientes.XLSX',
    );
    expect(book.format).toBe('XLSX');
    expect(() => readImportFile(buildXlsx([['a'], ['b']]), 'p.csv')).toThrow(
      EXTENSION_MISMATCH_MESSAGE,
    );
    expect(() => readImportFile(csvBytes('a\nb'), 'p.xlsx')).toThrow(
      EXTENSION_MISMATCH_MESSAGE,
    );
    expect(() => readImportFile(xls, 'p.xls')).toThrow(LEGACY_XLS_MESSAGE);
    expect(() => readImportFile(xls, 'p.xlsx')).toThrow(LEGACY_XLS_MESSAGE);
    expect(() => readImportFile(csvBytes('a\nb'), 'p.pdf')).toThrow(
      UNSUPPORTED_EXTENSION_MESSAGE,
    );
    expect(() => readImportFile(csvBytes('nombres\n\n'), 'p.csv')).toThrow(
      NO_ROWS_MESSAGE,
    );
  });
});
