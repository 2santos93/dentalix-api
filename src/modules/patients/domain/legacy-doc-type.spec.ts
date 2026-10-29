// Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
import { $Enums } from '@prisma/client';
import { DOCUMENT_TYPES } from './document-type';
import {
  LEGACY_CODES,
  LEGACY_DOC_TYPES,
  LEGACY_DOC_TYPE_SYNONYMS,
  docTypeFromCode,
  docTypeFromStored,
  legacyStoredDocType,
  resolveDocTypeInput,
} from './legacy-doc-type';

const PROTOTYPE_KEYS = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
];

describe('legacy-doc-type (DX-327)', () => {
  it('legacy codes map to their generic type', () => {
    expect(LEGACY_DOC_TYPES).toEqual({
      CC: 'NATIONAL_ID',
      TI: 'NATIONAL_ID',
      CE: 'RESIDENCE_PERMIT',
      PASSPORT: 'PASSPORT',
      OTHER: 'OTHER',
    });
    expect([...LEGACY_CODES]).toEqual(Object.values($Enums.DocType));
    for (const code of LEGACY_CODES) {
      expect(docTypeFromCode(code)).toBe(LEGACY_DOC_TYPES[code]);
      expect(docTypeFromStored(code)).toBe(LEGACY_DOC_TYPES[code]);
    }
  });

  it('generic codes map to themselves', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(docTypeFromCode(t)).toBe(t);
      expect(docTypeFromStored(t)).toBe(t);
    }
  });

  it('no function of this module returns or builds a document label', () => {
    const generic = new Set<unknown>(DOCUMENT_TYPES);
    const inputs = [...LEGACY_CODES, ...DOCUMENT_TYPES, 'X'];
    const outputs: unknown[] = [...Object.values(LEGACY_DOC_TYPES)];
    for (const code of inputs) {
      outputs.push(docTypeFromCode(code));
      if (code !== 'X') {
        outputs.push(docTypeFromStored(code));
        outputs.push(resolveDocTypeInput(code));
      }
    }
    for (const out of outputs) {
      expect(out === null || generic.has(out)).toBe(true);
    }
    for (const [code] of LEGACY_DOC_TYPE_SYNONYMS) {
      expect(LEGACY_CODES).toContain(code);
    }
    // @ts-expect-error: el resultado es un código, no tiene etiqueta.
    expect(docTypeFromCode('CC')?.label).toBeUndefined();
  });

  it('docTypeFromCode returns null for unknown codes, lower case and prototype keys', () => {
    for (const code of ['X', '', 'cc', 'national_id', ...PROTOTYPE_KEYS]) {
      expect(docTypeFromCode(code)).toBeNull();
    }
  });

  it('docTypeFromStored throws on an unknown code', () => {
    for (const code of ['X', 'cc', ...PROTOTYPE_KEYS]) {
      expect(() => docTypeFromStored(code)).toThrow(/DX-327/);
    }
  });

  it('legacyStoredDocType projects every generic type and round-trips', () => {
    expect(DOCUMENT_TYPES.map(legacyStoredDocType)).toEqual([
      'CC',
      'PASSPORT',
      'CE',
      'OTHER',
      'OTHER',
    ]);
    for (const t of DOCUMENT_TYPES) {
      // TAX_ID no tiene código antiguo propio: se proyecta a OTHER y vuelve
      // como OTHER (el trigger conserva TAX_ID en la columna nueva).
      expect(docTypeFromCode(legacyStoredDocType(t))).toBe(
        t === 'TAX_ID' ? 'OTHER' : t,
      );
    }
  });

  it('resolveDocTypeInput keeps a generic type', () => {
    for (const t of DOCUMENT_TYPES) expect(resolveDocTypeInput(t)).toBe(t);
  });

  it('legacy resolveDocTypeInput turns CC and TI into NATIONAL_ID and CE into RESIDENCE_PERMIT', () => {
    expect(resolveDocTypeInput('CC')).toBe('NATIONAL_ID');
    expect(resolveDocTypeInput('TI')).toBe('NATIONAL_ID');
    expect(resolveDocTypeInput('CE')).toBe('RESIDENCE_PERMIT');
    expect(resolveDocTypeInput('PASSPORT')).toBe('PASSPORT');
    expect(resolveDocTypeInput('OTHER')).toBe('OTHER');
  });

  it('resolveDocTypeInput rejects an unknown type', () => {
    for (const code of ['X', 'cc', ...PROTOTYPE_KEYS]) {
      expect(() => resolveDocTypeInput(code)).toThrow();
    }
  });

  it('legacy synonyms are the import aliases, as normalized keys', () => {
    expect(LEGACY_DOC_TYPE_SYNONYMS.map(([code]) => code)).toEqual([
      'CC',
      'TI',
      'CE',
      'PASSPORT',
      'OTHER',
    ]);
    for (const [, keys] of LEGACY_DOC_TYPE_SYNONYMS) {
      for (const k of keys) expect(k).toMatch(/^[a-z0-9]+$/);
    }
    expect(LEGACY_DOC_TYPE_SYNONYMS[0][1]).toContain('cedula');
  });
});
