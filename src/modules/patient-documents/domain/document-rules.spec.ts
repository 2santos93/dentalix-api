import { createHash } from 'node:crypto';
import { PatientDocumentCategory as PrismaCategory } from '@prisma/client';
import { isFileKey } from '../../../shared/storage/file-key';
import {
  normalizeOriginalName,
  PATIENT_DOCUMENT_CATEGORIES,
  PATIENT_DOCUMENT_URL_TTL_SECONDS,
  PatientDocumentRuleError,
  sha256Hex,
  storageKeyFor,
  validateCategory,
  validateClinicalDate,
  validateToothNumbers,
  validateNotes,
  validateVoidReason,
  CONTROL_CHARS_MESSAGE,
  PATIENT_DOCUMENT_UPLOAD_TTL_SECONDS,
} from './document-rules';

/** El error es del dominio Y el mensaje es exactamente ese (no un prefijo). */
function expectRuleError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PatientDocumentRuleError);
  expect((caught as Error).message).toBe(message);
}

const TENANT = '0b6f2c3e-6f3a-4c1e-9a52-1d2f3e4a5b6c';
const DOC = '7c1d9e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

describe('normalizeOriginalName (DX-151)', () => {
  it('quita rutas y controles: solo queda el nombre', () => {
    expect(normalizeOriginalName('../../etc/passwd\n.pdf')).toBe('passwd.pdf');
    expect(normalizeOriginalName('C:\\Users\\ana\\rx\tpanorámica.png')).toBe(
      'rxpanorámica.png',
    );
    expect(normalizeOriginalName('  informe final.pdf  ')).toBe(
      'informe final.pdf',
    );
  });

  it('quita los caracteres de control bidi (nombre «gpj.exe» disfrazado)', () => {
    expect(normalizeOriginalName('foto\u202Egnp.exe')).toBe('fotognp.exe');
  });

  it.each([
    ['U+2028', 'a b.pdf'],
    ['U+2029', 'a b.pdf'],
    ['U+061C', 'a؜b.pdf'],
    ['U+2060', 'a⁠b.pdf'],
    ['U+2064', 'a⁤b.pdf'],
    ['U+00AD', 'a­b.pdf'],
    ['U+FEFF', '﻿ab.pdf'],
  ])('quita %s', (_label, raw) => {
    expect(normalizeOriginalName(raw)).toBe('ab.pdf');
  });

  it('recorta a 255 conservando la extensión', () => {
    const name = normalizeOriginalName(`${'a'.repeat(400)}.pdf`);
    expect(Array.from(name)).toHaveLength(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('recorta por caracteres, no por unidades UTF-16', () => {
    const name = normalizeOriginalName(`${'🦷'.repeat(300)}.png`);
    expect(Array.from(name)).toHaveLength(255);
    expect(name.endsWith('🦷.png')).toBe(true);
  });

  it.each(['', '   ', '../', '..', '.', '\n\t', 'a/b/'])(
    '«%s» → «documento»',
    (raw) => {
      expect(normalizeOriginalName(raw)).toBe('documento');
    },
  );
});

describe('validateCategory', () => {
  it('acepta exactamente las categorías del enum de la BD', () => {
    expect([...PATIENT_DOCUMENT_CATEGORIES].sort()).toEqual(
      Object.values(PrismaCategory).sort(),
    );
    for (const c of PATIENT_DOCUMENT_CATEGORIES) {
      expect(validateCategory(c)).toBe(c);
    }
  });

  it.each([undefined, '', 'xray', 'INVOICE', 3])('rechaza %p', (value) => {
    expectRuleError(
      () => validateCategory(value),
      'La categoría no es válida.',
    );
  });
});

describe('validateToothNumbers', () => {
  it('sin dientes → lista vacía', () => {
    expect(validateToothNumbers(undefined)).toEqual([]);
    expect(validateToothNumbers([])).toEqual([]);
  });

  it('acepta FDI permanentes y temporales', () => {
    expect(validateToothNumbers(['11', ' 48 ', '55', '85'])).toEqual([
      '11',
      '48',
      '55',
      '85',
    ]);
  });

  it.each(['19', '56', '9', '00', '11a', ''])('«%s» no es FDI', (tooth) => {
    expectRuleError(
      () => validateToothNumbers(['11', tooth]),
      `El diente «${tooth}» no es un número FDI válido.`,
    );
  });

  it.each<[unknown, string]>([
    [11, '11'],
    [null, 'null'],
    [{}, '{}'],
    [undefined, 'sin valor'],
  ])('un elemento %p que no es texto da el mensaje FDI', (tooth, label) => {
    expectRuleError(
      () => validateToothNumbers(['11', tooth as string]),
      `El diente «${label}» no es un número FDI válido.`,
    );
  });

  it('sin duplicados', () => {
    expectRuleError(
      () => validateToothNumbers(['11', '21', '11']),
      'El diente «11» está repetido.',
    );
  });

  it('como mucho 8', () => {
    const nine = ['11', '12', '13', '14', '15', '16', '17', '18', '21'];
    expect(validateToothNumbers(nine.slice(0, 8))).toHaveLength(8);
    expectRuleError(
      () => validateToothNumbers(nine),
      'Como mucho 8 dientes por documento.',
    );
  });
});

describe('validateClinicalDate', () => {
  const today = '2026-10-20';

  it('sin fecha → null', () => {
    expect(validateClinicalDate(undefined, today)).toBeNull();
    expect(validateClinicalDate('', today)).toBeNull();
    expect(validateClinicalDate(null, today)).toBeNull();
  });

  it('hoy y el pasado valen', () => {
    expect(validateClinicalDate('2026-10-20', today)).toBe('2026-10-20');
    expect(validateClinicalDate('1999-02-28', today)).toBe('1999-02-28');
    expect(validateClinicalDate('2024-02-29', today)).toBe('2024-02-29');
  });

  it('futura → error', () => {
    expectRuleError(
      () => validateClinicalDate('2026-10-21', today),
      'La fecha clínica no puede ser futura.',
    );
  });

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '20-10-2026',
    '2026-1-1',
    '2026-10-20T00:00:00Z',
  ])('«%s» no es válida', (iso) => {
    expectRuleError(
      () => validateClinicalDate(iso, today),
      'La fecha clínica no es válida.',
    );
  });
});

describe('validateVoidReason', () => {
  it('recorta y acepta 3..500', () => {
    expect(validateVoidReason('  Duplicado  ')).toBe('Duplicado');
    expect(validateVoidReason('abc')).toBe('abc');
    expect(validateVoidReason('x'.repeat(500))).toHaveLength(500);
  });

  it.each([undefined, '', '  ab  ', 'x'.repeat(501)])('rechaza %p', (r) => {
    expectRuleError(
      () => validateVoidReason(r),
      'El motivo debe tener entre 3 y 500 caracteres.',
    );
  });
});

describe('validateVoidReason cuenta puntos de código (como char_length)', () => {
  it.each(['🦷🦷', '🦷a', '  🦷🦷  '])('«%s» (2 caracteres) → error', (r) => {
    expectRuleError(
      () => validateVoidReason(r),
      'El motivo debe tener entre 3 y 500 caracteres.',
    );
  });

  it('500 emojis valen; 501 no', () => {
    expect(validateVoidReason('🦷'.repeat(500))).toBe('🦷'.repeat(500));
    expectRuleError(
      () => validateVoidReason('🦷'.repeat(501)),
      'El motivo debe tener entre 3 y 500 caracteres.',
    );
  });

  it('3 emojis valen', () => {
    expect(validateVoidReason('🦷🦷🦷')).toBe('🦷🦷🦷');
  });
});

describe('validateNotes', () => {
  it.each([undefined, null, '', '   '])('%p → null', (notes) => {
    expect(validateNotes(notes)).toBeNull();
  });

  it('recorta y acepta hasta 500 puntos de código', () => {
    expect(validateNotes('  control en 6 meses  ')).toBe('control en 6 meses');
    expect(validateNotes('x'.repeat(500))).toHaveLength(500);
    expect(validateNotes('🦷'.repeat(500))).toBe('🦷'.repeat(500));
  });

  it.each(['x'.repeat(501), '🦷'.repeat(501)])(
    '501 caracteres → error',
    (notes) => {
      expectRuleError(
        () => validateNotes(notes),
        'Las notas admiten hasta 500 caracteres.',
      );
    },
  );
});

describe('notas y motivo sin caracteres de control (Postgres rechaza 0x00)', () => {
  const BAD = [
    'hola\u0000mundo',
    'abc\u0007def',
    'abc\u001bdef',
    'abc\u007fdef',
    'abc\u0085def',
  ];

  it.each(BAD)('validateNotes(%j) → error', (notes) => {
    expectRuleError(() => validateNotes(notes), CONTROL_CHARS_MESSAGE);
  });

  it.each(BAD)('validateVoidReason(%j) → error', (reason) => {
    expectRuleError(() => validateVoidReason(reason), CONTROL_CHARS_MESSAGE);
  });

  it('el mensaje es el acordado', () => {
    expect(CONTROL_CHARS_MESSAGE).toBe(
      'El texto contiene caracteres no permitidos.',
    );
  });

  it('salto de línea (también CRLF del formulario) y tabulador sí valen', () => {
    expect(validateNotes('línea 1\r\nlínea 2\tfin')).toBe(
      'línea 1\r\nlínea 2\tfin',
    );
    expect(validateVoidReason('motivo\nen dos líneas')).toBe(
      'motivo\nen dos líneas',
    );
  });
});

describe('sha256Hex / storageKeyFor / TTL', () => {
  it('sha256 en hex minúsculas', () => {
    const bytes = Buffer.from('radiografía');
    const hex = sha256Hex(bytes);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('la clave es patient-documents/<tenant>/<id>.<ext> y cumple isFileKey', () => {
    const key = storageKeyFor(TENANT, DOC, 'application/pdf');
    expect(key).toBe(`patient-documents/${TENANT}/${DOC}.pdf`);
    expect(isFileKey(key)).toBe(true);
    expect(
      isFileKey(
        storageKeyFor(
          TENANT,
          DOC,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).toBe(true);
  });

  it('no arma claves con ids que no sean uuid', () => {
    expect(() => storageKeyFor('../x', DOC, 'image/png')).toThrow();
    expect(() => storageKeyFor(TENANT, 'informe.pdf', 'image/png')).toThrow();
  });

  it('las URL firmadas viven 5 minutos', () => {
    expect(PATIENT_DOCUMENT_URL_TTL_SECONDS).toBe(300);
  });
});

describe('PATIENT_DOCUMENT_UPLOAD_TTL_SECONDS (DX-259)', () => {
  it('el POST prefirmado vale 15 minutos (subidas lentas desde el móvil)', () => {
    expect(PATIENT_DOCUMENT_UPLOAD_TTL_SECONDS).toBe(900);
  });
});
