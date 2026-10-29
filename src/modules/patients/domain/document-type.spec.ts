import { $Enums } from '@prisma/client';
import {
  DOCUMENT_TYPES,
  DOC_TYPE_LABEL,
  DOC_TYPE_LABEL_MAX,
  DocTypeLabelError,
  GENERIC_DOC_TYPE_NAMES,
  documentText,
  documentTypeKey,
  documentTypeName,
  isDocumentType,
  normalizeDocTypeLabel,
  type ClinicDocumentTypeNames,
} from './document-type';

describe('document-type (DX-327)', () => {
  it('DOCUMENT_TYPES lists the five generic types in order and matches the Prisma enum', () => {
    expect(DOCUMENT_TYPES).toEqual([
      'NATIONAL_ID',
      'PASSPORT',
      'RESIDENCE_PERMIT',
      'TAX_ID',
      'OTHER',
    ]);
    expect([...DOCUMENT_TYPES]).toEqual(Object.values($Enums.DocumentType));
  });

  it('DOC_TYPE_LABEL has the neutral label of each type', () => {
    expect(DOC_TYPE_LABEL).toEqual({
      NATIONAL_ID: 'Documento nacional',
      PASSPORT: 'Pasaporte',
      RESIDENCE_PERMIT: 'Permiso de residencia',
      TAX_ID: 'Identificación fiscal',
      OTHER: 'Otro documento',
    });
  });

  it('isDocumentType accepts the five and nothing else', () => {
    for (const t of DOCUMENT_TYPES) expect(isDocumentType(t)).toBe(true);
    for (const v of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'national_id',
      '',
      ' NATIONAL_ID',
      null,
      undefined,
      1,
      {},
    ]) {
      expect(isDocumentType(v)).toBe(false);
    }
  });

  it('normalizeDocTypeLabel trims, collapses spaces and turns empty into null', () => {
    expect(normalizeDocTypeLabel(undefined)).toBeUndefined();
    expect(normalizeDocTypeLabel(null)).toBeNull();
    expect(normalizeDocTypeLabel('')).toBeNull();
    expect(normalizeDocTypeLabel('   ')).toBeNull();
    expect(normalizeDocTypeLabel('  ID   local\t ')).toBe('ID local');
    expect(normalizeDocTypeLabel('Документ  А')).toBe('Документ А');
  });

  it('normalizeDocTypeLabel rejects more than 40 code points and control or format characters', () => {
    expect(DOC_TYPE_LABEL_MAX).toBe(40);
    const forty = '😀'.repeat(40);
    expect(forty.length).toBe(80); // 80 unidades UTF-16, 40 puntos de código
    expect(normalizeDocTypeLabel(forty)).toBe(forty);
    expect(() => normalizeDocTypeLabel('😀'.repeat(41))).toThrow(
      DocTypeLabelError,
    );
    expect(() => normalizeDocTypeLabel('a'.repeat(41))).toThrow(
      DocTypeLabelError,
    );
    // También un sustituto suelto (`\p{Cs}`), que la BD rechazaría (500).
    for (const bad of [
      'ID\u0007local',
      'ID​local',
      '‮ID local',
      'a\ud800',
      '\udc00a',
    ]) {
      expect(() => normalizeDocTypeLabel(bad)).toThrow(DocTypeLabelError);
    }
  });

  describe('documentTypeName', () => {
    const clinic: ClinicDocumentTypeNames = {
      NATIONAL_ID: 'Documento A',
      PASSPORT: null,
      RESIDENCE_PERMIT: undefined,
    };

    it.each([
      ['NATIONAL_ID', 'ID local', clinic, 'ID local'],
      ['NATIONAL_ID', null, clinic, 'Documento A'],
      ['NATIONAL_ID', undefined, clinic, 'Documento A'],
      ['NATIONAL_ID', null, {}, 'Documento nacional'],
      ['PASSPORT', null, clinic, 'Pasaporte'],
      ['RESIDENCE_PERMIT', undefined, clinic, 'Permiso de residencia'],
      ['TAX_ID', null, clinic, 'Identificación fiscal'],
      ['OTHER', 'Документ А', clinic, 'Документ А'],
    ] as const)(
      "documentTypeName prefers the patient's label, then the clinic's local name, then the generic name (%s, %p)",
      (type, label, names, expected) => {
        expect(documentTypeName(type, label, names)).toBe(expected);
      },
    );

    it('documentTypeName ignores prototype keys in the clinic names', () => {
      const proto = JSON.parse(
        '{"__proto__": {"OTHER": "Documento A"}}',
      ) as ClinicDocumentTypeNames;
      expect(documentTypeName('OTHER', null, proto)).toBe('Otro documento');
      const inherited = Object.create({
        PASSPORT: 'Documento A',
      }) as ClinicDocumentTypeNames;
      expect(documentTypeName('PASSPORT', null, inherited)).toBe('Pasaporte');
      const withConstructor = {
        constructor: 'Documento A',
      } as unknown as ClinicDocumentTypeNames;
      expect(documentTypeName('TAX_ID', null, withConstructor)).toBe(
        'Identificación fiscal',
      );
    });
  });

  it('documentText prints the name before the number', () => {
    expect(documentText('ID local', 'RX-123')).toBe('ID local RX-123');
    expect(documentText('文書A', 'DEMO-9')).toBe('文書A DEMO-9');
  });

  it('documentText with no number is null', () => {
    expect(documentText('ID local', null)).toBeNull();
    expect(documentText('ID local', '')).toBeNull();
  });

  it('documentTypeKey ignores case, Latin accents, spaces and punctuation', () => {
    const key = documentTypeKey('Nómbre Locál');
    expect(key).toBe('nombrelocal');
    expect(documentTypeKey('nombre-local')).toBe(key);
    expect(documentTypeKey('NOMBRE LOCAL')).toBe(key);
    expect(documentTypeKey('  nombre.\tlocal / ')).toBe(key);
    expect(documentTypeKey('Documento Á')).toBe(documentTypeKey('documento a'));
  });

  it('documentTypeKey keeps every script', () => {
    const names = [
      'Документ А',
      'وثيقة أ',
      '文書A',
      'ドキュメント',
      'トキュメント',
    ];
    const keys = names.map(documentTypeKey);
    for (const k of keys) {
      expect(k).not.toBe('');
      expect(k).toMatch(/[^\x00-\x7f]/); // eslint-disable-line no-control-regex
    }
    expect(new Set(keys).size).toBe(names.length);
    expect(documentTypeKey('документ а')).toBe(documentTypeKey('Документ А'));
    expect(documentTypeKey('ДОКУМЕНТ-А')).toBe(documentTypeKey('Документ А'));
    // El dakuten es parte de la letra: no se quita.
    expect(documentTypeKey('ドキュメント')).toBe('ドキュメント');
    expect(documentTypeKey('ドキュメント')).not.toBe(
      documentTypeKey('トキュメント'),
    );
    // La hamza del alif tampoco: «أ» no es «ا».
    expect(documentTypeKey('وثيقة أ')).not.toBe(documentTypeKey('وثيقة ا'));
    // La forma de ancho completo es la misma clave.
    expect(documentTypeKey('文書Ａ')).toBe(documentTypeKey('文書a'));
  });

  it('documentTypeKey of a name made only of punctuation or symbols is empty', () => {
    for (const raw of ['---', '★', ' . / - ', '']) {
      expect(documentTypeKey(raw)).toBe('');
    }
  });

  it('GENERIC_DOC_TYPE_NAMES has the codes and the generic names of spec §4.7 and no key is shared by two types', () => {
    expect(GENERIC_DOC_TYPE_NAMES).toEqual({
      NATIONAL_ID: [
        'nationalid',
        'documentonacional',
        'documentonacionaldeidentidad',
        'documentodeidentidad',
        'documentoidentidad',
        'identidad',
      ],
      PASSPORT: ['passport', 'pasaporte', 'pa', 'pas', 'pp'],
      RESIDENCE_PERMIT: [
        'residencepermit',
        'permisoderesidencia',
        'permisoresidencia',
      ],
      TAX_ID: ['taxid', 'identificacionfiscal', 'idfiscal'],
      OTHER: ['other', 'otro', 'otrodocumento'],
    });
    const seen = new Map<string, string>();
    for (const t of DOCUMENT_TYPES) {
      const keys = GENERIC_DOC_TYPE_NAMES[t];
      // Cada entrada ya es una clave, y el código y la etiqueta del tipo están.
      for (const k of keys) expect(documentTypeKey(k)).toBe(k);
      expect(keys).toContain(documentTypeKey(t));
      expect(keys).toContain(documentTypeKey(DOC_TYPE_LABEL[t]));
      for (const k of keys) {
        expect(seen.get(k) ?? t).toBe(t);
        seen.set(k, t);
      }
    }
  });
});
