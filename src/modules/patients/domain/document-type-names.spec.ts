import { DOCUMENT_TYPES, documentTypeKey } from './document-type';
import {
  DOC_TYPE_NAME_FIELD,
  DOC_TYPE_NAME_MAX,
  DocumentTypeNameError,
  normalizeDocumentTypeName,
  validateDocumentTypeNames,
} from './document-type-names';
import { IMPORT_DOC_TYPE_ALIASES } from './legacy-document-codes';
import { GENERIC_DOC_TYPE_NAMES } from './document-type';

const NONE = {
  NATIONAL_ID: null,
  PASSPORT: null,
  RESIDENCE_PERMIT: null,
  TAX_ID: null,
  OTHER: null,
};

describe('document-type-names (DX-327, R16)', () => {
  it('DOC_TYPE_NAME_FIELD names the tenant column of each type', () => {
    expect(DOC_TYPE_NAME_FIELD).toEqual({
      NATIONAL_ID: 'docTypeNameNationalId',
      PASSPORT: 'docTypeNamePassport',
      RESIDENCE_PERMIT: 'docTypeNameResidencePermit',
      TAX_ID: 'docTypeNameTaxId',
      OTHER: 'docTypeNameOther',
    });
    expect(Object.keys(DOC_TYPE_NAME_FIELD)).toEqual([...DOCUMENT_TYPES]);
  });

  it('normalizeDocumentTypeName trims, collapses spaces, turns empty into null and allows 60 code points', () => {
    expect(DOC_TYPE_NAME_MAX).toBe(60);
    expect(normalizeDocumentTypeName(null)).toBeNull();
    expect(normalizeDocumentTypeName(undefined)).toBeNull();
    expect(normalizeDocumentTypeName('')).toBeNull();
    expect(normalizeDocumentTypeName('   ')).toBeNull();
    expect(normalizeDocumentTypeName('  ID   local\t ')).toBe('ID local');
    // R7 «junta espacios»: tabulador, salto de línea y U+2028 son espacio
    // (`\s`), así que se juntan en uno y se aceptan, no son «de control».
    expect(normalizeDocumentTypeName('ID\n\u2028local\r\n')).toBe('ID local');
    // Los 60 se cuentan tras recortar y juntar.
    const padded = `  ${'a'.repeat(30)}    ${'b'.repeat(29)}  `;
    expect([...padded].length).toBeGreaterThan(60);
    expect(normalizeDocumentTypeName(padded)).toBe(
      `${'a'.repeat(30)} ${'b'.repeat(29)}`,
    );
    const sixty = '😀'.repeat(59) + 'a';
    expect([...sixty].length).toBe(60);
    expect(normalizeDocumentTypeName(sixty)).toBe(sixty);
  });

  it('normalizeDocumentTypeName rejects 61 code points and control or format characters', () => {
    expect(() => normalizeDocumentTypeName('a'.repeat(61))).toThrow(
      new DocumentTypeNameError(
        'El nombre del documento admite hasta 60 caracteres.',
      ),
    );
    expect(() => normalizeDocumentTypeName('a' + '😀'.repeat(60))).toThrow(
      DocumentTypeNameError,
    );
    // También un sustituto suelto (`\p{Cs}`): no es texto y la BD lo
    // rechazaría con un 500.
    for (const bad of [
      'ID\u0007local',
      'ID​local',
      '‮ID local',
      'a\ud800',
      '\udc00a',
    ]) {
      expect(() => normalizeDocumentTypeName(bad)).toThrow(
        new DocumentTypeNameError(
          'El nombre del documento no puede llevar caracteres de control.',
        ),
      );
    }
  });

  it('a name with no letter or number is rejected', () => {
    for (const bad of ['---', '★', ' . / ']) {
      expect(() => normalizeDocumentTypeName(bad)).toThrow(
        new DocumentTypeNameError(
          'El nombre necesita al menos una letra o un número.',
        ),
      );
    }
    for (const ok of ['Документ А', 'وثيقة أ', '文書A']) {
      expect(normalizeDocumentTypeName(ok)).toBe(ok);
    }
    expect(validateDocumentTypeNames({ ...NONE, OTHER: '---' })).toEqual({
      ok: false,
      message: 'El nombre necesita al menos una letra o un número.',
    });
  });

  it('two names that differ only in Latin accents or case are ambiguous', () => {
    expect(
      validateDocumentTypeNames({
        ...NONE,
        NATIONAL_ID: 'Documento A',
        TAX_ID: 'documento á',
      }),
    ).toEqual({
      ok: false,
      message:
        '“documento á” ya es el nombre de Documento nacional. Cada tipo necesita un nombre distinto.',
    });
  });

  it('validateDocumentTypeNames rejects two types with the same name', () => {
    expect(
      validateDocumentTypeNames({
        ...NONE,
        NATIONAL_ID: 'Nombre Local',
        PASSPORT: 'nombre-local',
      }),
    ).toEqual({
      ok: false,
      message:
        '“nombre-local” ya es el nombre de Documento nacional. Cada tipo necesita un nombre distinto.',
    });
    // En otra escritura, igual.
    expect(
      validateDocumentTypeNames({
        ...NONE,
        RESIDENCE_PERMIT: 'Документ А',
        OTHER: 'документ-а',
      }),
    ).toEqual({
      ok: false,
      message:
        '“документ-а” ya es el nombre de Permiso de residencia. Cada tipo necesita un nombre distinto.',
    });
  });

  it("validateDocumentTypeNames rejects a name that is another type's generic name or code", () => {
    for (const name of ['Pasaporte', 'passport', 'PAS']) {
      expect(validateDocumentTypeNames({ ...NONE, NATIONAL_ID: name })).toEqual(
        {
          ok: false,
          message: `“${name}” es el nombre de Pasaporte. Elige otro.`,
        },
      );
    }
    expect(
      validateDocumentTypeNames({ ...NONE, OTHER: 'Identificación fiscal' }),
    ).toEqual({
      ok: false,
      message:
        '“Identificación fiscal” es el nombre de Identificación fiscal. Elige otro.',
    });
    // El genérico del propio tipo sí vale.
    expect(
      validateDocumentTypeNames({ ...NONE, PASSPORT: 'Pasaporte' }),
    ).toEqual({ ok: true, names: { ...NONE, PASSPORT: 'Pasaporte' } });
    expect(
      validateDocumentTypeNames({ ...NONE, NATIONAL_ID: 'national id' }),
    ).toEqual({ ok: true, names: { ...NONE, NATIONAL_ID: 'national id' } });
  });

  it('validateDocumentTypeNames accepts five different names and all nulls', () => {
    const names = {
      NATIONAL_ID: '  ID   local ',
      PASSPORT: 'Documento A',
      RESIDENCE_PERMIT: 'Документ А',
      TAX_ID: 'وثيقة أ',
      OTHER: '文書A',
    };
    expect(validateDocumentTypeNames(names)).toEqual({
      ok: true,
      names: { ...names, NATIONAL_ID: 'ID local' },
    });
    expect(validateDocumentTypeNames(NONE)).toEqual({ ok: true, names: NONE });
    // Ausente = sin nombre; vacío también.
    expect(validateDocumentTypeNames({ TAX_ID: '  ' })).toEqual({
      ok: true,
      names: NONE,
    });
  });

  it('validateDocumentTypeNames ignores prototype and unknown keys', () => {
    const names = JSON.parse(
      '{"__proto__": "Documento A", "constructor": "x", "FOO": "Pasaporte"}',
    ) as Record<string, string>;
    expect(validateDocumentTypeNames(names)).toEqual({ ok: true, names: NONE });
  });

  it('import aliases are not checked at save time', () => {
    // Un sinónimo antiguo que no es código ni nombre genérico de ningún tipo
    // se acepta como nombre de un tipo distinto del suyo (la clínica no los
    // ve; en la importación gana el nombre de la clínica, R19).
    const generic = new Set(Object.values(GENERIC_DOC_TYPE_NAMES).flat());
    let checked = 0;
    for (const [own, keys] of IMPORT_DOC_TYPE_ALIASES) {
      const target = DOCUMENT_TYPES.find((t) => t !== own)!;
      for (const key of keys.filter((k) => !generic.has(k))) {
        expect(documentTypeKey(key)).toBe(key);
        expect(validateDocumentTypeNames({ ...NONE, [target]: key })).toEqual({
          ok: true,
          names: { ...NONE, [target]: key },
        });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
