// Excepción G5.3 (DX-334): códigos de documento anteriores a DX-327.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENT_TYPES, GENERIC_DOC_TYPE_NAMES } from './document-type';
import {
  IMPORT_DOC_TYPE_ALIASES,
  docTypeFromCode,
  docTypeFromStored,
} from './legacy-document-codes';

const PROTOTYPE_KEYS = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
];

describe('legacy-document-codes (DX-327, solo lectura)', () => {
  it('old codes in stored JSON read as their generic type', () => {
    expect(docTypeFromStored('CC')).toBe('NATIONAL_ID');
    expect(docTypeFromStored('TI')).toBe('NATIONAL_ID');
    expect(docTypeFromStored('CE')).toBe('RESIDENCE_PERMIT');
    expect(docTypeFromStored('PASSPORT')).toBe('PASSPORT');
    expect(docTypeFromStored('OTHER')).toBe('OTHER');
  });

  it('generic codes map to themselves', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(docTypeFromCode(t)).toBe(t);
      expect(docTypeFromStored(t)).toBe(t);
    }
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

  it('import aliases are normalized keys of a generic type, never a generic name again', () => {
    const generic = new Set(Object.values(GENERIC_DOC_TYPE_NAMES).flat());
    for (const [type, keys] of IMPORT_DOC_TYPE_ALIASES) {
      expect(DOCUMENT_TYPES).toContain(type);
      for (const k of keys) {
        expect(k).toMatch(/^[a-z0-9]+$/);
        expect(generic.has(k)).toBe(false);
      }
    }
    const all = IMPORT_DOC_TYPE_ALIASES.flatMap(([, keys]) => keys);
    expect(new Set(all).size).toBe(all.length);
  });

  it('nothing here writes an old code: the module exports only readers and aliases', () => {
    const source = readFileSync(
      join(__dirname, 'legacy-document-codes.ts'),
      'utf8',
    );
    expect(
      [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map(
        (m) => m[1],
      ),
    ).toEqual([
      'docTypeFromCode',
      'docTypeFromStored',
      'IMPORT_DOC_TYPE_ALIASES',
      'IMPORT_DOC_NUMBER_HEADER_ALIASES',
    ]);
  });
});
