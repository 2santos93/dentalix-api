import {
  decodeCsv,
  decodeWindows1252,
  detectDelimiter,
  parseCsv,
  parseCsvRecords,
} from './csv-parser';
import {
  EXTENSION_MISMATCH_MESSAGE,
  LEGACY_XLS_MESSAGE,
  NOT_A_TABLE_TXT_MESSAGE,
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

async function collect(bytes: Buffer): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const record of await readXlsx(bytes)) out.push(record);
  return out;
}

async function records(bytes: Buffer): Promise<RawRecord[]> {
  return (await collect(bytes)).filter((r) => r.cells.some((c) => c !== ''));
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
    const bytes = csvBytes(`a,b\n"${'x'.repeat(4_000_000)}`);
    const meter = meterStringCalls();
    let records: RawRecord[];
    try {
      records = [...parseCsv(bytes).records];
    } finally {
      meter.restore();
    }
    // Lineal: el tramo entre comillas se salta con UNA búsqueda (cursor que
    // avanza), no se vuelve a recorrer desde el principio por cada carácter.
    // Se cuenta trabajo, no reloj (TST-034).
    expect(meter.calls.indexOf).toBeLessThanOrEqual(2);
    expect(records[1].cells[0].length).toBeLessThanOrEqual(10_000);
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
    const book = rawBook('<sheetData>' + '<row>'.repeat(1_000_000), [], true);
    const meter = meterStringCalls();
    try {
      await expect(collect(book)).rejects.toThrow(ImportFileError);
    } finally {
      meter.restore();
    }
    // Lineal: un puñado de búsquedas (el cierre que falta se busca una vez),
    // no una por cada uno de los 1.000.000 de `<row>` (cuadrático). Se cuenta
    // trabajo, no reloj (TST-034); hoy son 10.
    expect(meter.calls.indexOf).toBeLessThanOrEqual(100);
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
    const all = await collect(
      rawBook(`<sheetData>${one.repeat(1000)}</sheetData>`),
    );
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

  it('un .txt que no es una tabla dice que solo se admiten .csv o .xlsx (QA O2)', async () => {
    await expect(
      readImportFile(csvBytes('hola, esto es una nota\n'), 'notas.txt'),
    ).rejects.toThrow(NOT_A_TABLE_TXT_MESSAGE);
    await expect(
      readImportFile(csvBytes('una línea suelta\n'), 'notas.txt'),
    ).rejects.toThrow(/solo se admiten archivos \.csv o \.xlsx/i);
    // Un .txt tabulado («Texto Unicode» de Excel) se sigue leyendo.
    const unicode = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('nombres\tdoc\r\nAna\t1\r\n', 'utf16le'),
    ]);
    expect(
      (await readImportFile(unicode, 'pacientes.txt')).table.rows,
    ).toHaveLength(1);
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

/**
 * Cuenta llamadas a los métodos de texto con los que se recorre un fichero
 * (`indexOf` del escáner, `charCodeAt`/`fromCharCode` de una decodificación
 * a mano) mientras está puesto. Mide TRABAJO, no reloj: el número es el
 * mismo con la máquina sola que con la CI corriendo 350 suites a la vez
 * (TST-034: los umbrales en milisegundos daban rojos falsos). Se quita
 * siempre con `restore()`. Solo toca los objetos del contexto de Jest de
 * este fichero.
 */
function meterStringCalls() {
  const calls = { indexOf: 0, charCodeAt: 0, fromCharCode: 0 };
  const proto = String.prototype;
  // Los originales por su descriptor: son métodos que se llaman con `this`.
  const original = <T>(name: 'indexOf' | 'charCodeAt') =>
    Object.getOwnPropertyDescriptor(proto, name)?.value as T;
  const indexOf =
    original<(this: string, search: string, position?: number) => number>(
      'indexOf',
    );
  const charCodeAt =
    original<(this: string, index: number) => number>('charCodeAt');
  const { fromCharCode } = String;
  proto.indexOf = function (this: string, search: string, position?: number) {
    calls.indexOf += 1;
    return indexOf.call(this, search, position);
  };
  proto.charCodeAt = function (this: string, index: number) {
    calls.charCodeAt += 1;
    return charCodeAt.call(this, index);
  };
  String.fromCharCode = (...codes: number[]) => {
    calls.fromCharCode += 1;
    return fromCharCode(...codes);
  };
  return {
    calls,
    restore() {
      proto.indexOf = indexOf;
      proto.charCodeAt = charCodeAt;
      String.fromCharCode = fromCharCode;
    },
  };
}

/**
 * Corre un trabajo asíncrono y mide cuánto trabaja SIN soltar el hilo: un
 * `setImmediate` que se reprograma a sí mismo late una vez por vuelta del
 * event loop y apunta cuántas búsquedas (`indexOf`) hizo el lector desde su
 * último latido. Si el lector cede el hilo, cada tramo entre latidos está
 * acotado; si un bucle no cede, todo su recorrido cae en una sola vuelta.
 * Es determinista: depende del código y de la entrada, no de la CPU libre.
 */
async function watchTurns<T>(work: () => Promise<T>): Promise<{
  outcome: T | Error;
  maxPerTurn: number;
  total: number;
}> {
  const meter = meterStringCalls();
  let seen = 0;
  let maxPerTurn = 0;
  let running = true;
  const beat = () => {
    maxPerTurn = Math.max(maxPerTurn, meter.calls.indexOf - seen);
    seen = meter.calls.indexOf;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  let outcome: T | Error;
  try {
    outcome = await work();
  } catch (err) {
    outcome = err as Error;
  } finally {
    running = false;
    meter.restore();
  }
  maxPerTurn = Math.max(maxPerTurn, meter.calls.indexOf - seen);
  return { outcome, maxPerTurn, total: meter.calls.indexOf };
}

/*
 * Búsquedas que el lector puede hacer, como mucho, en una sola vuelta del
 * event loop. Cede el hilo cada 8.192 pasos del escáner (`YIELD_STEPS` de
 * xlsx-reader.ts) y cada paso son unas pocas búsquedas (la etiqueta, su
 * cierre y las de dentro de la celda): un tramo real anda por 16.000–33.000
 * (medido). Un bucle que no cede las hace todas de una vez: con
 * `YIELD_STEPS` infinito salen de 128.000 a 8 M en una sola vuelta (los
 * 1,5–5,3 s de hilo parado de antes del arreglo de la revisión B1).
 */
const MAX_SEARCHES_PER_TURN = 64 * 1024;

describe('XLSX: topes de estructura y event loop (revisión 2026-10-23, B1)', () => {
  jest.setTimeout(60_000);

  const HEAD =
    `<row r="1">${inline('A1', 'nombres')}${inline('B1', 'apellidos')}</row>` +
    `<row r="2">${inline('A2', 'Ana')}${inline('B2', 'Ríos')}</row>`;
  const sheetWith = (rows: string) =>
    `<worksheet><sheetData>${HEAD}${rows}</sheetData></worksheet>`;
  const part = (name: string, xml: string) => ({
    name,
    data: Buffer.from(xml),
  });

  /**
   * El hilo se suelta: ninguna vuelta del event loop pasa del tope de
   * búsquedas. Y el contador vio trabajar al lector (si no, la prueba no
   * diría nada).
   */
  function expectYieldsTheThread(m: { maxPerTurn: number; total: number }) {
    expect(m.maxPerTurn).toBeGreaterThan(0);
    expect(m.total).toBeGreaterThanOrEqual(m.maxPerTurn);
    expect(m.maxPerTurn).toBeLessThanOrEqual(MAX_SEARCHES_PER_TURN);
  }

  async function expectRejectedYielding(book: Buffer, message: RegExp) {
    expect(book.length).toBeLessThan(200 * 1024);
    const { outcome, maxPerTurn, total } = await watchTurns(() =>
      readImportFile(book, 'x.xlsx'),
    );
    expect(outcome).toBeInstanceOf(ImportFileError);
    expect((outcome as Error).message).toMatch(message);
    expectYieldsTheThread({ maxPerTurn, total });
  }

  it('sharedStrings con 5,5 M de <si/>: 400 sin bloquear el hilo', async () => {
    await expectRejectedYielding(
      rawBook(sheetWith(''), [
        part('xl/sharedStrings.xml', `<sst>${'<si/>'.repeat(5_500_000)}</sst>`),
      ]),
      /cadenas de texto/,
    );
  });

  it('styles.xml con 5,5 M de <xf/>: 400 (más de 64.000 estilos) sin bloquear', async () => {
    await expectRejectedYielding(
      rawBook(sheetWith(''), [
        part(
          'xl/styles.xml',
          `<styleSheet><cellXfs>${'<xf/>'.repeat(5_500_000)}</cellXfs></styleSheet>`,
        ),
      ]),
      /64\.000 estilos/,
    );
  });

  it('una fila con 2,5 M de <c r="CW3"/>: 400 (más de 16.384 celdas) sin bloquear', async () => {
    await expectRejectedYielding(
      rawBook(
        sheetWith(`<row r="3">${'<c r="CW3"/>'.repeat(2_500_000)}</row>`),
      ),
      /16\.384 celdas/,
    );
  });

  it('una fila con 6 M de <c/> sin referencia: 400 sin bloquear', async () => {
    await expectRejectedYielding(
      rawBook(sheetWith(`<row r="3">${'<c/>'.repeat(6_000_000)}</row>`)),
      /16\.384 celdas/,
    );
  });

  it('muchas filas anchas que respetan el tope por fila: presupuesto global, sin bloquear', async () => {
    const row = `<row>${'<c/>'.repeat(16_000)}</row>`;
    await expectRejectedYielding(
      rawBook(sheetWith(row.repeat(400))),
      /demasiado complej/,
    );
  });

  it('etiquetas que se parecen (<cx/>) también cuentan y ceden el hilo', async () => {
    await expectRejectedYielding(
      rawBook(sheetWith(`<row r="3">${'<cx/>'.repeat(6_000_000)}</row>`)),
      /demasiado complej/,
    );
  });

  it('una cadena con 1 M de tramos <t/>: 400 sin bloquear', async () => {
    await expectRejectedYielding(
      rawBook(sheetWith(''), [
        part(
          'xl/sharedStrings.xml',
          `<sst><si>${'<t/>'.repeat(1_000_000)}</si></sst>`,
        ),
      ]),
      /demasiado complej/,
    );
  });

  it('un libro normal de 10.000 pacientes se sigue leyendo entero sin bloquear', async () => {
    const rows: string[][] = [
      ['nombres', 'apellidos', 'documento', 'telefono'],
    ];
    for (let i = 0; i < 10_000; i += 1) {
      rows.push([
        `Nombre ${i}`,
        `Apellido ${i}`,
        String(1_000_000 + i),
        '3001234567',
      ]);
    }
    const { outcome, maxPerTurn, total } = await watchTurns(() =>
      readImportFile(buildXlsx(rows), 'x.xlsx'),
    );
    expect(outcome).not.toBeInstanceOf(Error);
    expect(
      (outcome as Awaited<ReturnType<typeof readImportFile>>).table.rows,
    ).toHaveLength(10_000);
    expectYieldsTheThread({ maxPerTurn, total });
  });
});

describe('CSV Windows-1252 (revisión 2026-10-23, I1)', () => {
  it('decodifica el tramo 0x80–0x9F y el resto como Latin-1', () => {
    const bytes = Buffer.from([
      0x80, 0x82, 0x93, 0x94, 0x96, 0x97, 0x99, 0x9f, 0x81, 0xe9, 0xf1, 0x41,
    ]);
    expect(decodeWindows1252(bytes)).toBe('€‚“”–—™Ÿ\u0081éñA');
  });

  it('un CSV de 5 MB en Windows-1252 se decodifica en nativo, sin trabajo por carácter', () => {
    const head = Buffer.from('nombres;apellidos\nJosé;Peña\n', 'latin1');
    const body = Buffer.alloc(5 * 1024 * 1024 - head.length, 0xe9);
    let high = 0;
    for (let i = 0; i < body.length; i += 97) {
      body[i] = 0x80; // €
      high += 1;
    }
    const bytes = Buffer.concat([head, body]);
    const meter = meterStringCalls();
    let decoded: ReturnType<typeof decodeCsv>;
    try {
      decoded = decodeCsv(bytes);
    } finally {
      meter.restore();
    }
    // Lo decodifica Node (latin1) y en JS solo se corrige el tramo 0x80–0x9F:
    // como mucho una conversión por byte de ese tramo. A mano, carácter a
    // carácter, eran 5 M de `fromCharCode` (1,2 s; revisión I1). Se cuenta
    // trabajo, no reloj (TST-034).
    expect(
      meter.calls.charCodeAt + meter.calls.fromCharCode,
    ).toBeLessThanOrEqual(high);
    expect(decoded.encoding).toBe('windows-1252');
    expect(decoded.text.startsWith('nombres;apellidos\nJosé;Peña\n€')).toBe(
      true,
    );
    expect(decoded.text).toHaveLength(bytes.length);
  });
});
