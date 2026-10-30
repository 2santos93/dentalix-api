import type { DocumentType } from '@prisma/client';
import {
  DOCUMENT_TYPES,
  type ClinicDocumentTypeNames,
} from '../../patients/domain/document-type';
import { LEGACY_DOC_NUMBER_HEADER_SYNONYMS } from '../../patients/domain/legacy-doc-type';
import {
  readStoredColumnMapping,
  resolveMapping,
  storedColumnMapping,
  suggestMapping,
} from './column-mapping';
import { dedupeRows } from './dedupe';
import { fieldsToRevert, fillEmpty, type FillablePatient } from './fill-empty';
import { examplePhone } from '../../../shared/phone/phone-number';
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
import { resolveBalanceColumns } from './opening-balance-sheet';
import { parseCsv } from './csv-parser';
import { toTable } from './tabular-file';

const TODAY = '2026-10-21';
/** Sin región por defecto: estos casos no tienen teléfono (R14, ningún país). */
const NO_REGION = null;
/** Una clínica sin nombres locales (como empiezan todas, R16). */
const NO_NAMES: ClinicDocumentTypeNames = {};

/** El motivo de un resultado `{ error }` (o '' si no es un error). */
const errorOf = (r: { value: unknown } | { error: string }): string =>
  'error' in r ? r.error : '';

describe('mapeo de columnas (DX-107)', () => {
  it('sugiere por sinónimos sin tildes ni mayúsculas, una cabecera por campo', () => {
    expect(
      suggestMapping([
        'Número de Documento',
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
      docNumber: 'Número de Documento',
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
        defaultDocType: 'NATIONAL_ID',
      }),
    ).toEqual({
      indexes: { docNumber: 0, firstName: 1, lastName: 2 },
      headers: { docNumber: 'doc', firstName: 'nom', lastName: 'ape' },
      defaultDocType: 'NATIONAL_ID',
    });
  });
});

describe('normalización de campos', () => {
  it('documento: notación científica con su arreglo', () => {
    expect(normalizeDocNumber('1.020.304.050')).toEqual({
      value: '1020304050',
    });
    expect(errorOf(normalizeDocNumber('1,02E+09'))).toMatch(
      /notación científica.*formato Texto/,
    );
    // QA 2026-10-23 D2: el valor del mensaje es el de la fila, no uno fijo.
    const real = errorOf(normalizeDocNumber(' 1,09E+09 '));
    expect(real).toContain('(1,09E+09)');
    expect(real).not.toContain('1,02E+09');
    expect(normalizeDocNumber('ab-12 345')).toEqual({ value: 'AB12345' });
    // DX-327 (M14): los guiones ya no se guardan; la clave es la misma.
    expect(normalizeDocNumber('rx-77')).toEqual({ value: 'RX77' });
    expect(docKey('rx-77')).toBe('RX77');
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

  it('teléfono en E.164 con la región por defecto de la sede; un fijo corto tal cual', () => {
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

  it('a phone without + takes the default region, and without one it is never rewritten', () => {
    expect(normalizePhone('0412-1234567', 'VE')).toEqual({
      value: '+584121234567',
    });
    // Sin región por defecto no se quita el 0 ni se inventa un indicativo.
    expect(normalizePhone('06 1234 5678', null)).toEqual({
      value: '06 1234 5678',
    });
    expect(normalizePhone('+39 06 1234 5678', null)).toEqual({
      value: '+390612345678',
    });
  });

  it('the import stores E.164 only for a valid number', () => {
    // Válido como +, pero la librería no lo da por válido: tal cual.
    expect(normalizePhone('+57 412 1234567', 'CO')).toEqual({
      value: '+57 412 1234567',
    });
    // La región conserva el 0 que forma parte del número.
    expect(normalizePhone('06 1234 5678', 'IT')).toEqual({
      value: '+390612345678',
    });
    expect(normalizePhone('234 5678', 'IT')).toEqual({ value: '234 5678' });
  });

  it('an ambiguous number is never VALID, never a wa.me and never stored as E.164', () => {
    expect(normalizePhone('0058 412 1234567', 'CO')).toEqual({
      value: '0058 412 1234567',
    });
    expect(normalizePhone('49 151 23456789', 'DE')).toEqual({
      value: '49 151 23456789',
    });
  });

  it('a number with an extension is stored as typed', () => {
    expect(normalizePhone('0212-5551234 ext 3', 'VE')).toEqual({
      value: '0212-5551234 ext 3',
    });
    expect(normalizePhone('+58 212 5551234 ext. 12', null)).toEqual({
      value: '+58 212 5551234 ext. 12',
    }); // 12 dígitos del número más 4 de la extensión: válido, tal cual.
    expect(normalizePhone('+58 212 5551234 ext 1234', null)).toEqual({
      value: '+58 212 5551234 ext 1234',
    });
    // La extensión se reconoce como en el adaptador.
    expect(normalizePhone('0212-5551234 x3', 'VE')).toEqual({
      value: '0212-5551234 x3',
    });
    expect(normalizePhone('0212-5551234 extensión 3', 'VE')).toEqual({
      value: '0212-5551234 extensión 3',
    });
    // Una letra fuera de la extensión sigue siendo un error.
    expect(normalizePhone('0212-5551234 casa', 'VE')).toHaveProperty('error');
  });
});

/** El mensaje de error de una celda de tipo, con estos nombres de la clínica. */
function typeError(raw: string, clinicNames: ClinicDocumentTypeNames): string {
  const mapping = resolveMapping(['tipo', 'doc', 'nom', 'ape'], {
    columns: {
      docType: 'tipo',
      docNumber: 'doc',
      firstName: 'nom',
      lastName: 'ape',
    },
  });
  const r = validateRow(
    { rowNumber: 2, cells: [raw, 'RX-1', 'A', 'B'] },
    mapping,
    {
      defaultRegion: NO_REGION,
      today: TODAY,
      clinicNames,
    },
  );
  return r.issues.find((i) => i.column === 'tipo')?.message ?? '';
}

describe('tipos de documento de la importación (DX-327)', () => {
  it.each([
    ['NATIONAL_ID', 'NATIONAL_ID'],
    ['national id', 'NATIONAL_ID'],
    ['Documento nacional', 'NATIONAL_ID'],
    ['Documento nacional de identidad', 'NATIONAL_ID'],
    ['Documento de identidad', 'NATIONAL_ID'],
    ['documento identidad', 'NATIONAL_ID'],
    ['Identidad', 'NATIONAL_ID'],
    ['PASSPORT', 'PASSPORT'],
    ['Pasaporte', 'PASSPORT'],
    ['P.A.', 'PASSPORT'],
    ['pas', 'PASSPORT'],
    ['PP', 'PASSPORT'],
    ['RESIDENCE_PERMIT', 'RESIDENCE_PERMIT'],
    ['Residence permit', 'RESIDENCE_PERMIT'],
    ['Permiso de residencia', 'RESIDENCE_PERMIT'],
    ['permiso residencia', 'RESIDENCE_PERMIT'],
    ['TAX_ID', 'TAX_ID'],
    ['Tax ID', 'TAX_ID'],
    ['Identificación fiscal', 'TAX_ID'],
    ['ID fiscal', 'TAX_ID'],
    ['OTHER', 'OTHER'],
    ['Otro', 'OTHER'],
    ['Otro documento', 'OTHER'],
  ])(
    'generic codes and their Spanish and English names are recognized (%s → %s)',
    (raw, type) => {
      expect(parseDocType(raw, NO_NAMES)).toBe(type);
    },
  );

  it.each([
    ['C.C.', 'NATIONAL_ID'],
    ['cc', 'NATIONAL_ID'],
    ['Cédula', 'NATIONAL_ID'],
    ['Cédula de ciudadanía', 'NATIONAL_ID'],
    ['TI', 'NATIONAL_ID'],
    ['Tarjeta de identidad', 'NATIONAL_ID'],
    ['CE', 'RESIDENCE_PERMIT'],
    ['Cédula de extranjería', 'RESIDENCE_PERMIT'],
    ['Extranjería', 'RESIDENCE_PERMIT'],
  ])(
    'legacy synonyms map to their generic type with no label (%s → %s)',
    (raw, type) => {
      // parseDocType devuelve solo el tipo: no hay etiqueta que derivar (Q3).
      expect(parseDocType(raw, NO_NAMES)).toBe(type);
    },
  );

  it('legacy dni and nit still map to OTHER; rut is not a type', () => {
    expect(parseDocType('DNI', NO_NAMES)).toBe('OTHER');
    expect(parseDocType('NIT', NO_NAMES)).toBe('OTHER');
    expect(parseDocType('RC', NO_NAMES)).toBe('OTHER');
    // Pre-flight I7: `rut` solo era cabecera del número; no se añade nada.
    expect(parseDocType('RUT', NO_NAMES)).toBeNull();
    expect(typeError('RUT', NO_NAMES)).toMatch(
      /^Tipo de documento no reconocido/,
    );
  });

  it('legacy number header synonyms still recognize the number column', () => {
    expect([...LEGACY_DOC_NUMBER_HEADER_SYNONYMS]).toEqual([
      'cedula',
      'dni',
      'rut',
    ]);
    for (const header of ['Cédula', 'DNI', 'RUT']) {
      expect(suggestMapping([header, 'Nombre', 'Apellidos'])).toMatchObject({
        docNumber: header,
      });
      expect(
        resolveBalanceColumns([header, 'Importe', 'Moneda']),
      ).toMatchObject({ docNumber: header });
    }
    const docNumber = IMPORT_FIELDS.find((f) => f.key === 'docNumber')!;
    expect(docNumber.synonyms).toEqual(
      expect.arrayContaining([...LEGACY_DOC_NUMBER_HEADER_SYNONYMS]),
    );
  });

  it('headers that matched before still match, and headers in any script match too', () => {
    // La clave anterior (solo [a-z0-9]) cuando la nueva no casa ninguna.
    expect(
      suggestMapping(['Documento №', 'Nombres (名)', 'Apellidos']),
    ).toMatchObject({
      docNumber: 'Documento №',
      firstName: 'Nombres (名)',
      lastName: 'Apellidos',
    });
    expect(
      resolveBalanceColumns(['Documento №', 'Importe', 'Moneda']),
    ).toMatchObject({ docNumber: 'Documento №' });
    // La nueva gana cuando las dos casan: «Nº documento» es el número.
    expect(suggestMapping(['Nº documento'])).toEqual({
      docNumber: 'Nº documento',
    });
    // Letras de ancho completo: solo la clave nueva las lee.
    expect(suggestMapping(['ＮＯＭＢＲＥＳ'])).toEqual({
      firstName: 'ＮＯＭＢＲＥＳ',
    });
    // Cabeceras con tildes y en mayúsculas, como antes.
    expect(suggestMapping(['NÚMERO DE DOCUMENTO', 'Teléfono'])).toEqual({
      docNumber: 'NÚMERO DE DOCUMENTO',
      phone: 'Teléfono',
    });
  });

  // Nombres locales en otras escrituras (I4).
  it.each([
    // «ドキュメント» en ancho completo y en medio ancho (el dakuten va aparte).
    ['japonés', 'ドキュメント', 'ﾄﾞｷｭﾒﾝﾄ'],
    ['cirílico', 'Личный Документ', 'личный-документ'],
    ['árabe', 'وثيقة شخصية', 'وثيقة  شخصية'],
  ])(
    'a local name in a non-Latin script is recognized on import (%s)',
    (_script, name, written) => {
      const names: ClinicDocumentTypeNames = { NATIONAL_ID: name };
      expect(parseDocType(name, names)).toBe('NATIONAL_ID');
      expect(parseDocType(written, names)).toBe('NATIONAL_ID');
      expect(parseDocType(name, NO_NAMES)).toBeNull();
    },
  );

  it('a stored mapping keeps the legacy default for older replicas and reads the generic one', () => {
    const columns = { docNumber: 'doc' };
    expect(storedColumnMapping(columns, 'NATIONAL_ID')).toEqual({
      columns,
      defaultDocType: 'CC',
      defaultDocumentType: 'NATIONAL_ID',
    });
    // TAX_ID no tiene código anterior: la réplica anterior lee OTHER.
    expect(storedColumnMapping(columns, 'TAX_ID')).toMatchObject({
      defaultDocType: 'OTHER',
      defaultDocumentType: 'TAX_ID',
    });
    expect(storedColumnMapping(columns, null)).toEqual({
      columns,
      defaultDocType: null,
      defaultDocumentType: null,
    });
    // La API nueva prefiere el genérico…
    expect(
      readStoredColumnMapping(storedColumnMapping(columns, 'TAX_ID')),
    ).toEqual({ columns, defaultDocType: 'TAX_ID' });
    // …y un lote de la API anterior (solo el código) se traduce (R6).
    expect(readStoredColumnMapping({ columns, defaultDocType: 'TI' })).toEqual({
      columns,
      defaultDocType: 'NATIONAL_ID',
    });
    expect(readStoredColumnMapping({})).toEqual({
      columns: {},
      defaultDocType: null,
    });
  });

  it.each(DOCUMENT_TYPES)(
    'one number rule for every type accepts letter prefixes and separators (%s)',
    (type) => {
      // Una sola regla: el tipo no entra (R15).
      void type;
      expect(normalizeDocNumber('1.234.567')).toEqual({ value: '1234567' });
      expect(normalizeDocNumber('V-12.345.678')).toEqual({
        value: 'V12345678',
      });
      expect(normalizeDocNumber('e-81234567')).toEqual({ value: 'E81234567' });
      expect(normalizeDocNumber('J-12345678-9')).toEqual({
        value: 'J123456789',
      });
      expect(normalizeDocNumber('12345678Z')).toEqual({ value: '12345678Z' });
      expect(normalizeDocNumber('AB/123')).toEqual({ value: 'AB123' });
      const mapping = resolveMapping(['doc', 'nom', 'ape'], {
        columns: { docNumber: 'doc', firstName: 'nom', lastName: 'ape' },
        defaultDocType: type,
      });
      const r = validateRow(
        { rowNumber: 2, cells: ['V-12.345.678', 'A', 'B'] },
        mapping,
        {
          defaultRegion: NO_REGION,
          today: TODAY,
          clinicNames: NO_NAMES,
        },
      );
      expect(r.issues).toEqual([]);
      expect(r.data).toMatchObject({ docType: type, docNumber: 'V12345678' });
    },
  );

  it('a number is rejected only when empty of letters and digits, over 30, or in scientific notation', () => {
    const rule =
      'Número de documento no válido: letras y dígitos (hasta 30), con separadores opcionales.';
    expect(normalizeDocNumber('---')).toEqual({ error: rule });
    expect(normalizeDocNumber('A'.repeat(31))).toEqual({ error: rule });
    expect(normalizeDocNumber('A'.repeat(30))).toEqual({
      value: 'A'.repeat(30),
    });
    expect(normalizeDocNumber('RX#1')).toEqual({ error: rule });
    expect(errorOf(normalizeDocNumber('1.23E+9'))).toMatch(
      /notación científica/,
    );
    for (const message of [rule, errorOf(normalizeDocNumber('1.23E+9'))]) {
      expect(message).not.toMatch(
        /NATIONAL_ID|PASSPORT|RESIDENCE_PERMIT|TAX_ID|OTHER|pasaporte|nacional/i,
      );
    }
  });

  it.each([
    // Copiados de la regla anterior (`row-validation.ts:124-175` antes de
    // DX-327): lo que pasaba con cada código sigue pasando, igual o sin
    // separadores.
    ['CC', '1.020.304.050', '1020304050'],
    ['CC', '1,020,304', '1020304'],
    ['CC', '102 030 405', '102030405'],
    ['TI', '1-020-304', '1020304'],
    ['TI', '123456789012345', '123456789012345'],
    ['CE', 'ab-12.345', 'AB12345'],
    ['CE', 'X12345678901234', 'X12345678901234'],
    ['PASSPORT', 'ab-12 345', 'AB12345'],
    ['PASSPORT', 'A'.repeat(20), 'A'.repeat(20)],
    ['OTHER', 'nuip-77', 'NUIP77'],
    ['OTHER', 'a.b', 'AB'],
    ['OTHER', '7', '7'],
    ['OTHER', `${'1'.repeat(29)}-`, '1'.repeat(29)],
  ])(
    'legacy: nothing accepted before DX-327 is rejected now (%s %s)',
    (_code, raw, value) => {
      expect(normalizeDocNumber(raw)).toEqual({ value });
    },
  );

  it("an unknown type lists the generic codes and names, and the clinic's local names when it has them", () => {
    const base =
      'Tipo de documento no reconocido: usa NATIONAL_ID, PASSPORT, RESIDENCE_PERMIT, TAX_ID u OTHER, o su nombre (documento nacional, pasaporte, permiso de residencia, identificación fiscal, otro)';
    expect(typeError('ZZ', NO_NAMES)).toBe(`${base}.`);
    expect(
      typeError('ZZ', {
        NATIONAL_ID: null,
        TAX_ID: 'ID local',
        PASSPORT: 'Libreta',
      }),
    ).toBe(`${base}, o uno de los nombres de tu clínica: Libreta, ID local.`);
  });

  it("a clinic's local name is recognized ignoring case and accents, and wins over a legacy synonym", () => {
    const names: ClinicDocumentTypeNames = { TAX_ID: 'Nombre Local' };
    for (const raw of [
      'Nombre Local',
      'nombre local',
      'NOMBRE-LOCAL',
      'Nómbre Locál',
    ]) {
      expect(parseDocType(raw, names)).toBe('TAX_ID');
    }
    // Sin el nombre local, no es ningún tipo.
    expect(parseDocType('nombre local', NO_NAMES)).toBeNull();
  });

  it("legacy: a clinic's local name equal to a legacy key of another type wins", () => {
    // «CE» era un sinónimo anterior de RESIDENCE_PERMIT; la clínica lo usa
    // para TAX_ID: gana la clínica (R19, prioridad 1).
    expect(parseDocType('CE', { TAX_ID: 'CE' })).toBe('TAX_ID');
    expect(parseDocType('CE', NO_NAMES)).toBe('RESIDENCE_PERMIT');
    // La clínica que llama «Cédula de identidad» a su documento nacional lo
    // importa con ese nombre; sin configurarlo, no es ningún tipo.
    const names: ClinicDocumentTypeNames = {
      NATIONAL_ID: 'Cédula de identidad',
    };
    expect(parseDocType('cedula de identidad', names)).toBe('NATIONAL_ID');
    expect(parseDocType('Cédula de identidad', NO_NAMES)).toBeNull();
  });

  it('a single letter is unknown unless the clinic configures it', () => {
    expect(parseDocType('V', NO_NAMES)).toBeNull();
    expect(typeError('V', NO_NAMES)).toMatch(
      /^Tipo de documento no reconocido.*\)\.$/,
    );
    expect(parseDocType('V', { NATIONAL_ID: 'V' })).toBe('NATIONAL_ID');
    expect(parseDocType('v', { NATIONAL_ID: 'V' })).toBe('NATIONAL_ID');
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
    defaultDocType: 'NATIONAL_ID',
  });
  const ctx = { defaultRegion: 'CO', today: TODAY, clinicNames: NO_NAMES };

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
      docType: 'NATIONAL_ID',
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

const existingDoc = (id: string, documentType: DocumentType, key: string) => ({
  id,
  documentType,
  docTypeLabel: null as string | null,
  docKey: key,
});

describe('dedupeRows', () => {
  it('dentro del fichero gana la primera; mismo nº con otro tipo es error', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('NATIONAL_ID', '111') },
        { rowNumber: 3, data: data('NATIONAL_ID', '111') },
        { rowNumber: 4, data: data('PASSPORT', '111') },
        { rowNumber: 5, data: data('NATIONAL_ID', '222') },
      ],
      [],
      'doc',
      NO_NAMES,
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
        { rowNumber: 2, data: data('NATIONAL_ID', '111') },
        { rowNumber: 3, data: data('NATIONAL_ID', 'X-9') },
        { rowNumber: 4, data: data('NATIONAL_ID', '333') },
      ],
      [
        existingDoc('p1', 'NATIONAL_ID', '111'),
        existingDoc('p2', 'RESIDENCE_PERMIT', 'X9'),
      ],
      undefined,
      NO_NAMES,
    );
    expect(r.fresh.map((x) => x.rowNumber)).toEqual([4]);
    expect(r.existing).toEqual([
      { rowNumber: 2, data: data('NATIONAL_ID', '111'), patientId: 'p1' },
    ]);
    expect(r.issues.map((i) => [i.row, i.kind, i.column])).toEqual([
      [2, 'DUPLICATE_EXISTING', 'Número de documento'],
      [3, 'ERROR', 'Número de documento'],
    ]);
  });

  it('existente con supresión parcial (Ley 1581): el aviso de la fila lo dice (revisión I2)', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('NATIONAL_ID', '111') },
        { rowNumber: 3, data: data('NATIONAL_ID', '222') },
      ],
      [
        {
          ...existingDoc('p1', 'NATIONAL_ID', '111'),
          partiallySuppressed: true,
        },
        {
          ...existingDoc('p2', 'NATIONAL_ID', '222'),
          partiallySuppressed: false,
        },
      ],
      undefined,
      NO_NAMES,
    );
    expect(r.existing.map((x) => x.patientId)).toEqual(['p1', 'p2']);
    const [suppressed, normal] = r.issues;
    expect(suppressed).toMatchObject({ row: 2, kind: 'DUPLICATE_EXISTING' });
    expect(suppressed.message).toMatch(/supresión de sus datos.*privacidad/);
    expect(suppressed.message).toMatch(/no se rellenarán/);
    expect(normal.message).not.toMatch(/supresión/);
  });

  it('the same number with the same generic type is the same patient', () => {
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('TAX_ID', 'J123456789') },
        { rowNumber: 3, data: data('TAX_ID', 'RX-1') },
        { rowNumber: 4, data: data('TAX_ID', 'RX1') },
      ],
      [existingDoc('p1', 'TAX_ID', 'J123456789')],
      undefined,
      NO_NAMES,
    );
    expect(r.existing.map((x) => [x.rowNumber, x.patientId])).toEqual([
      [2, 'p1'],
    ]);
    // Con guion y sin él es la misma clave (docKey no cambia).
    expect(r.fresh.map((x) => x.rowNumber)).toEqual([3]);
    expect(r.fileDuplicates).toBe(1);
    expect(r.conflicts).toBe(0);
  });

  it('legacy CC and TI with the same key are the same type after the migration', () => {
    // Una fila «CC» y otra «TI» del fichero dan las dos NATIONAL_ID (R3), y un
    // paciente que la BD tenía como TI ya es NATIONAL_ID: repetido y
    // existente, nunca «otro tipo» (R12).
    const cc = parseDocType('CC', NO_NAMES);
    const ti = parseDocType('TI', NO_NAMES);
    expect([cc, ti]).toEqual(['NATIONAL_ID', 'NATIONAL_ID']);
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data(cc!, '123') },
        { rowNumber: 3, data: data(ti!, '1.2.3') },
        { rowNumber: 4, data: data(ti!, '456') },
      ],
      [existingDoc('p1', 'NATIONAL_ID', '456')],
      undefined,
      NO_NAMES,
    );
    expect(r.conflicts).toBe(0);
    expect(r.issues.map((i) => [i.row, i.kind])).toEqual([
      [3, 'DUPLICATE_FILE'],
      [4, 'DUPLICATE_EXISTING'],
    ]);
  });

  it('messages name the type label, never a code', () => {
    const names: ClinicDocumentTypeNames = { PASSPORT: 'Nombre Local' };
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data('TAX_ID', '111') },
        { rowNumber: 3, data: data('PASSPORT', '111') },
        { rowNumber: 4, data: data('OTHER', '222') },
        { rowNumber: 5, data: data('RESIDENCE_PERMIT', '333') },
      ],
      [
        existingDoc('p1', 'NATIONAL_ID', '222'),
        {
          ...existingDoc('p2', 'NATIONAL_ID', '333'),
          docTypeLabel: 'ID local',
        },
      ],
      undefined,
      names,
    );
    const byRow = (row: number) => r.issues.find((i) => i.row === row)!;
    expect(byRow(3)).toMatchObject({
      message:
        'El número de documento ya aparece en la fila 2 con otro tipo (Identificación fiscal).',
      value: 'Nombre Local 111',
    });
    expect(byRow(4)).toMatchObject({
      message:
        'Ya hay un paciente en la clínica con este número de documento registrado como Documento nacional: revisa el tipo.',
      value: 'Otro documento 222',
    });
    // El paciente existente con etiqueta libre sale con su etiqueta (R17).
    expect(byRow(5).message).toContain('registrado como ID local:');
    expect(byRow(5).value).toBe('Permiso de residencia 333');
    for (const issue of r.issues) {
      expect(`${issue.message} ${issue.value}`).not.toMatch(
        /NATIONAL_ID|PASSPORT|RESIDENCE_PERMIT|TAX_ID|OTHER\b/,
      );
    }
  });

  // Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
  it('legacy: a dedupe message never prints a label derived from a legacy code', () => {
    // La fila «cédula» casa con un sinónimo anterior: su texto es el nombre
    // genérico, nunca el código ni el nombre de un país (Q3).
    const type = parseDocType('cédula', NO_NAMES)!;
    const r = dedupeRows(
      [
        { rowNumber: 2, data: data(type, '111') },
        { rowNumber: 3, data: data('PASSPORT', '111') },
      ],
      [existingDoc('p1', 'TAX_ID', '111')],
      undefined,
      NO_NAMES,
    );
    const texts = r.issues.map((i) => `${i.message} | ${i.value}`).join('\n');
    expect(texts).toContain('Documento nacional 111');
    expect(texts).not.toMatch(/\bCC\b|\bTI\b|[Cc][ée]dula/);
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
      ...data('NATIONAL_ID', '1'),
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
      ...data('NATIONAL_ID', '1'),
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
    const table = toTable(
      parseCsv(Buffer.from(templateCsv(examplePhone('CO')), 'utf8')).records,
    );
    expect(table.headers).toEqual(IMPORT_FIELDS.map((f) => f.header));
    const mapping = resolveMapping(table.headers, {
      columns: suggestMapping(table.headers),
    });
    const rows = table.rows.map((row) =>
      validateRow(row, mapping, {
        defaultRegion: 'CO',
        today: TODAY,
        clinicNames: NO_NAMES,
      }),
    );
    expect(rows.map((r) => r.issues)).toEqual([[], []]);
    expect(rows[0].data).toMatchObject({
      docType: 'NATIONAL_ID',
      birthDate: '1988-04-15',
      phone: '+573211234567',
    });
  });
});

describe('fila con más celdas que la cabecera', () => {
  it('es un error de la fila, sin columna, y no se importa', () => {
    const mapping = resolveMapping(['doc', 'nom', 'ape'], {
      columns: { docNumber: 'doc', firstName: 'nom', lastName: 'ape' },
      defaultDocType: 'NATIONAL_ID',
    });
    const r = validateRow(
      { rowNumber: 5, cells: ['1020', 'Ana', 'Pérez'], extraCells: true },
      mapping,
      { defaultRegion: 'CO', today: TODAY, clinicNames: NO_NAMES },
    );
    expect(r.data).toBeNull();
    expect(r.issues).toEqual([
      expect.objectContaining({ row: 5, column: null, kind: 'ERROR' }),
    ]);
    expect(r.issues[0].message).toMatch(/más celdas que la cabecera/);
  });
});
