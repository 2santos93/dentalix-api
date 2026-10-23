import { resolveMapping, suggestMapping } from './column-mapping';
import { dedupeRows } from './dedupe';
import { fieldsToRevert, fillEmpty, type FillablePatient } from './fill-empty';
import { csvCell, issuesCsv, templateCsv } from './import-csv';
import { IMPORT_FIELDS, type ImportPatientData } from './import-fields';
import {
  docKey,
  normalizeDocNumber,
  normalizePhone,
  parseBirthDate,
  parseDocType,
  parseSex,
  validateRow,
} from './row-validation';
import { parseCsv } from './csv-parser';
import { toTable } from './tabular-file';

const TODAY = '2026-10-21';

/** El motivo de un resultado `{ error }` (o '' si no es un error). */
const errorOf = (r: { value: unknown } | { error: string }): string =>
  'error' in r ? r.error : '';

describe('mapeo de columnas (DX-107)', () => {
  it('sugiere por sinónimos sin tildes ni mayúsculas, una cabecera por campo', () => {
    expect(
      suggestMapping([
        'Cédula',
        'Nombre',
        'Apellidos',
        'Fecha de Nacimiento',
        'Celular',
        'Correo',
        'Tipo Doc.',
        'X',
      ]),
    ).toEqual({
      docType: 'Tipo Doc.',
      docNumber: 'Cédula',
      firstName: 'Nombre',
      lastName: 'Apellidos',
      birthDate: 'Fecha de Nacimiento',
      phone: 'Celular',
      email: 'Correo',
    });
  });

  it('valida: cabecera inexistente, repetida y obligatorios (tipo por columna o por defecto)', () => {
    const headers = ['doc', 'nom', 'ape'];
    expect(() =>
      resolveMapping(headers, { columns: { firstName: 'nada' } }),
    ).toThrow(/no está en el archivo/);
    expect(() =>
      resolveMapping(headers, {
        columns: { firstName: 'nom', lastName: 'NOM' },
      }),
    ).toThrow(/elige una sola/);
    expect(() =>
      resolveMapping(headers, {
        columns: { firstName: 'nom', lastName: 'ape', docNumber: 'doc' },
      }),
    ).toThrow(/Tipo de documento/);
    expect(() =>
      resolveMapping(headers, { columns: { firstName: 'nom' } }),
    ).toThrow(/«Número de documento», «Apellidos»/);
    expect(
      resolveMapping(headers, {
        columns: { firstName: 'nom', lastName: 'ape', docNumber: 'doc' },
        defaultDocType: 'CC',
      }),
    ).toEqual({
      indexes: { docNumber: 0, firstName: 1, lastName: 2 },
      headers: { docNumber: 'doc', firstName: 'nom', lastName: 'ape' },
      defaultDocType: 'CC',
    });
  });
});

describe('normalización de campos', () => {
  it('tipo de documento por alias', () => {
    expect(parseDocType('C.C.')).toBe('CC');
    expect(parseDocType('Cédula de ciudadanía')).toBe('CC');
    expect(parseDocType('tarjeta de identidad')).toBe('TI');
    expect(parseDocType('Pasaporte')).toBe('PASSPORT');
    expect(parseDocType('RC')).toBe('OTHER');
    expect(parseDocType('XX')).toBeNull();
  });

  it('documento según el tipo; notación científica con su arreglo', () => {
    expect(normalizeDocNumber('CC', '1.020.304.050')).toEqual({
      value: '1020304050',
    });
    expect(normalizeDocNumber('CC', '10203A')).toHaveProperty('error');
    expect(errorOf(normalizeDocNumber('CC', '1,02E+09'))).toMatch(
      /notación científica.*formato Texto/,
    );
    // QA 2026-10-23 D2: el valor del mensaje es el de la fila, no uno fijo.
    const real = errorOf(normalizeDocNumber('CC', ' 1,09E+09 '));
    expect(real).toContain('(1,09E+09)');
    expect(real).not.toContain('1,02E+09');
    expect(normalizeDocNumber('PASSPORT', 'ab-12 345')).toEqual({
      value: 'AB12345',
    });
    expect(normalizeDocNumber('OTHER', 'nuip-77')).toEqual({
      value: 'NUIP-77',
    });
    expect(docKey('nuip-77')).toBe('NUIP77');
  });

  it('fecha de nacimiento: día primero, ISO, serie de Excel, con hora; rechaza 2 cifras, inexistentes y futuras', () => {
    expect(parseBirthDate('03/05/1990', TODAY)).toEqual({
      value: '1990-05-03',
    });
    expect(parseBirthDate('1990-05-03 00:00:00', TODAY)).toEqual({
      value: '1990-05-03',
    });
    expect(parseBirthDate('3.5.1990', TODAY)).toEqual({ value: '1990-05-03' });
    expect(parseBirthDate('32874', TODAY)).toEqual({ value: '1990-01-01' });
    expect(errorOf(parseBirthDate('3/5/90', TODAY))).toMatch(/2 cifras/);
    expect(errorOf(parseBirthDate('31/02/1990', TODAY))).toMatch(/no existe/);
    expect(parseBirthDate('22/10/2026', TODAY)).toEqual({
      error: 'La fecha de nacimiento es futura.',
    });
    expect(errorOf(parseBirthDate('1/1/1899', TODAY))).toMatch(/1900/);
    expect(parseBirthDate('mayo', TODAY)).toHaveProperty('error');
  });

  it('sexo con alias; «sin dato» queda sin especificar', () => {
    expect(parseSex('Femenino')).toEqual({ value: 'F' });
    expect(parseSex('h')).toEqual({ value: 'M' });
    expect(parseSex('No reporta')).toEqual({ value: null });
    expect(parseSex('?')).toBeNull();
  });

  it('teléfono en E.164 con el indicativo del país de la sede; un fijo corto tal cual', () => {
    expect(normalizePhone('310 123 4567', 'CO')).toEqual({
      value: '+573101234567',
    });
    expect(normalizePhone('+34 612 345 678', 'CO')).toEqual({
      value: '+34612345678',
    });
    expect(normalizePhone('612345678', 'ES')).toEqual({
      value: '+34612345678',
    });
    expect(normalizePhone('2345678', 'CO')).toEqual({ value: '2345678' });
    expect(
      errorOf(normalizePhone('310 123 4567 / 601 234 5678', 'CO')),
    ).toMatch(/más de un teléfono/);
    expect(normalizePhone('llamar', 'CO')).toHaveProperty('error');
    expect(normalizePhone('123', 'CO')).toHaveProperty('error');
  });
});

describe('validateRow', () => {
  const headers = [
    'tipo',
    'doc',
    'nombres',
    'apellidos',
    'nacimiento',
    'sexo',
    'tel',
    'email',
    'notas',
  ];
  const mapping = resolveMapping(headers, {
    columns: {
      docType: 'tipo',
      docNumber: 'doc',
      firstName: 'nombres',
      lastName: 'apellidos',
      birthDate: 'nacimiento',
      sex: 'sexo',
      phone: 'tel',
      email: 'email',
      notes: 'notas',
    },
    defaultDocType: 'CC',
  });
  const ctx = { countryCode: 'CO', today: TODAY };

  it('fila válida normalizada; tipo vacío usa el de por defecto', () => {
    const r = validateRow(
      {
        rowNumber: 2,
        cells: [
          '',
          '1.020.304',
          '  Ana  María ',
          'Pérez',
          '03/05/1990',
          'F',
          '3101234567',
          'ANA@Example.com',
          'línea 1\nlínea 2',
        ],
      },
      mapping,
      ctx,
    );
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({
      docType: 'CC',
      docNumber: '1020304',
      firstName: 'Ana María',
      lastName: 'Pérez',
      birthDate: '1990-05-03',
      sex: 'F',
      phone: '+573101234567',
      email: 'ana@example.com',
      notes: 'línea 1\nlínea 2',
    });
  });

  it('cada problema es un error (fila, columna del fichero, motivo en español) y la fila no se importa', () => {
    const r = validateRow(
      {
        rowNumber: 7,
        cells: [
          'ZZ',
          '',
          '',
          'Pérez',
          '40/40/2000',
          'q',
          'abc',
          'no-es-email',
          '',
        ],
      },
      mapping,
      ctx,
    );
    expect(r.data).toBeNull();
    expect(r.issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [7, 'nombres', 'Falta «Nombres».'],
      [7, 'tipo', expect.stringMatching(/Tipo de documento no reconocido/)],
      [7, 'doc', 'Falta el número de documento.'],
      [7, 'nacimiento', expect.stringMatching(/no existe|no reconocida/)],
      [7, 'sexo', expect.stringMatching(/Sexo no reconocido/)],
      [7, 'tel', expect.stringMatching(/Teléfono no válido/)],
      [7, 'email', 'Correo electrónico no válido.'],
    ]);
    expect(r.issues.every((i) => i.kind === 'ERROR')).toBe(true);
  });
});

const data = (
  docType: ImportPatientData['docType'],
  docNumber: string,
): ImportPatientData => ({
  docType,
  docNumber,
  firstName: 'A',
  lastName: 'B',
});

describe('dedupeRows', () => {
  it('dentro del fichero gana la primera; mismo nº con otro tipo es error', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('CC', '111') },
        { rowNumber: 3, data: data('CC', '111') },
        { rowNumber: 4, data: data('TI', '111') },
        { rowNumber: 5, data: data('CC', '222') },
      ],
      [],
      'doc',
    );
    expect(r.fresh.map((x) => x.rowNumber)).toEqual([2, 5]);
    expect(r.fileDuplicates).toBe(1);
    expect(r.conflicts).toBe(1);
    expect(r.issues.map((i) => [i.row, i.kind])).toEqual([
      [3, 'DUPLICATE_FILE'],
      [4, 'ERROR'],
    ]);
  });

  it('contra la BD: mismo tipo → existente; otro tipo → error', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('CC', '111') },
        { rowNumber: 3, data: data('TI', 'X-9') },
        { rowNumber: 4, data: data('CC', '333') },
      ],
      [
        { id: 'p1', docType: 'CC', docKey: '111' },
        { id: 'p2', docType: 'CE', docKey: 'X9' },
      ],
      undefined,
    );
    expect(r.fresh.map((x) => x.rowNumber)).toEqual([4]);
    expect(r.existing).toEqual([
      { rowNumber: 2, data: data('CC', '111'), patientId: 'p1' },
    ]);
    expect(r.issues.map((i) => [i.row, i.kind, i.column])).toEqual([
      [2, 'DUPLICATE_EXISTING', 'Número de documento'],
      [3, 'ERROR', 'Número de documento'],
    ]);
  });

  it('existente con supresión parcial (Ley 1581): el aviso de la fila lo dice (revisión I2)', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('CC', '111') },
        { rowNumber: 3, data: data('CC', '222') },
      ],
      [
        { id: 'p1', docType: 'CC', docKey: '111', partiallySuppressed: true },
        { id: 'p2', docType: 'CC', docKey: '222', partiallySuppressed: false },
      ],
      undefined,
    );
    expect(r.existing.map((x) => x.patientId)).toEqual(['p1', 'p2']);
    const [suppressed, normal] = r.issues;
    expect(suppressed).toMatchObject({ row: 2, kind: 'DUPLICATE_EXISTING' });
    expect(suppressed.message).toMatch(/supresión de sus datos.*Ley 1581/);
    expect(suppressed.message).toMatch(/no se rellenarán/);
    expect(normal.message).not.toMatch(/supresión/);
  });
});

describe('«Actualizar solo campos vacíos»', () => {
  const patient: FillablePatient = {
    birthDate: null,
    sex: 'UNSPECIFIED',
    phone: '  ',
    email: 'ya@tiene.com',
    address: null,
    occupation: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    notes: 'previa',
  };

  it('rellena solo lo vacío y nunca pisa un dato', () => {
    const filled = fillEmpty(patient, {
      ...data('CC', '1'),
      birthDate: '1990-01-01',
      sex: 'F',
      phone: '+573101234567',
      email: 'otro@x.com',
      notes: 'nueva',
    });
    expect(filled).toEqual({
      birthDate: '1990-01-01',
      sex: 'F',
      phone: '+573101234567',
    });
  });

  it('paciente con supresión parcial: nunca rellena los campos suprimidos (Ley 1581, revisión I2)', () => {
    const suppressed: FillablePatient = {
      ...patient,
      phone: null,
      email: null,
      notes: null,
      partiallySuppressedAt: new Date('2026-10-01T00:00:00Z'),
    };
    const filled = fillEmpty(suppressed, {
      ...data('CC', '1'),
      birthDate: '1990-01-01',
      phone: '+573101234567',
      email: 'otro@x.com',
      address: 'Calle 1',
      notes: 'nueva',
      emergencyContactName: 'Luis',
      emergencyContactPhone: '+573109999999',
      occupation: 'Docente',
    });
    expect(filled).toEqual({ birthDate: '1990-01-01', occupation: 'Docente' });
  });

  it('al deshacer solo revierte lo que sigue con el valor del lote', () => {
    const after: FillablePatient = {
      ...patient,
      birthDate: new Date('1990-01-01T00:00:00Z'),
      sex: 'F',
      phone: '+570000000000',
    };
    expect(
      fieldsToRevert(after, {
        birthDate: '1990-01-01',
        sex: 'F',
        phone: '+573101234567',
      }),
    ).toEqual(['birthDate', 'sex']);
  });
});

describe('CSV de la plantilla y del informe', () => {
  it('neutraliza fórmulas (inyección CSV), dobla comillas y lleva BOM + CRLF', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      `"'=HYPERLINK(""http://x"")"`,
    );
    expect(csvCell(' +1')).toBe(`"' +1"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('-2+3')).toBe(`"'-2+3"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('Ana')).toBe('"Ana"');
    const report = issuesCsv([
      { row: 9, column: '=cmd', kind: 'ERROR', message: 'm', value: '+57' },
      {
        row: 3,
        column: null,
        kind: 'DUPLICATE_FILE',
        message: 'd',
        value: null,
      },
    ]);
    expect(
      report.startsWith('﻿"Fila","Columna","Tipo","Motivo","Valor"\r\n'),
    ).toBe(true);
    expect(report.split('\r\n')[1]).toBe(
      '3,"","Repetido en el archivo","d",""',
    );
    expect(report.split('\r\n')[2]).toBe(`9,"'=cmd","Error","m","'+57"`);
  });

  it('la plantilla trae las columnas admitidas y se puede volver a leer con su mapeo sugerido', () => {
    const table = toTable(parseCsv(Buffer.from(templateCsv(), 'utf8')).records);
    expect(table.headers).toEqual(IMPORT_FIELDS.map((f) => f.header));
    const mapping = resolveMapping(table.headers, {
      columns: suggestMapping(table.headers),
    });
    const rows = table.rows.map((row) =>
      validateRow(row, mapping, { countryCode: 'CO', today: TODAY }),
    );
    expect(rows.map((r) => r.issues)).toEqual([[], []]);
    expect(rows[0].data).toMatchObject({
      docType: 'CC',
      birthDate: '1988-04-15',
      phone: '+573100000001',
    });
  });
});

describe('fila con más celdas que la cabecera', () => {
  it('es un error de la fila, sin columna, y no se importa', () => {
    const mapping = resolveMapping(['doc', 'nom', 'ape'], {
      columns: { docNumber: 'doc', firstName: 'nom', lastName: 'ape' },
      defaultDocType: 'CC',
    });
    const r = validateRow(
      { rowNumber: 5, cells: ['1020', 'Ana', 'Pérez'], extraCells: true },
      mapping,
      { countryCode: 'CO', today: TODAY },
    );
    expect(r.data).toBeNull();
    expect(r.issues).toEqual([
      expect.objectContaining({ row: 5, column: null, kind: 'ERROR' }),
    ]);
    expect(r.issues[0].message).toMatch(/más celdas que la cabecera/);
  });
});
