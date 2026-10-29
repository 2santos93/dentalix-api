import {
  MEMBER_NUMBER_DIGIT_MESSAGE,
  MEMBER_NUMBER_FORMAT_MESSAGE,
  MEMBER_NUMBER_REPEATED_MESSAGE,
  MEMBER_NUMBER_REQUIRED_MESSAGE,
  memberNumberChanged,
  memberNumberError,
  memberNumberLast4,
  normalizeMemberNumber,
  requiresMemberNumber,
} from './member-number-rules';
import { isExternalPayer, PAYER_TYPES } from '../../payers/domain/payer-type';

const EXTERNAL = [
  'INSURER',
  'PREPAID_PLAN',
  'PUBLIC_SYSTEM',
  'EMPLOYER',
] as const;

describe('nº de afiliado o póliza (SEC-049, regla única DX-311)', () => {
  describe('requiresMemberNumber', () => {
    it.each(PAYER_TYPES)(
      'requiresMemberNumber follows isExternalPayer for the five generic types (%s)',
      (type) => {
        expect(requiresMemberNumber(type)).toBe(isExternalPayer(type));
      },
    );

    it.each(EXTERNAL)('%s (pagador externo) lo exige', (type) => {
      expect(requiresMemberNumber(type)).toBe(true);
    });

    it('OTHER (interno: cortesía, empleados) no', () => {
      expect(requiresMemberNumber('OTHER')).toBe(false);
    });
  });

  describe('normalizeMemberNumber', () => {
    it('recorta los extremos y colapsa los espacios internos; vacío = null', () => {
      expect(normalizeMemberNumber('  10 20   30  ')).toBe('10 20 30');
      expect(normalizeMemberNumber('   ')).toBeNull();
      expect(normalizeMemberNumber(null)).toBeNull();
      expect(normalizeMemberNumber(undefined)).toBeNull();
    });
  });

  describe('memberNumberError', () => {
    it('mensajes neutros, sin tipo de pagador ni país', () => {
      expect(MEMBER_NUMBER_REQUIRED_MESSAGE).toBe(
        'El nº de afiliado o póliza es obligatorio con un pagador externo.',
      );
      expect(MEMBER_NUMBER_FORMAT_MESSAGE).toBe(
        'El nº de afiliado o póliza debe tener entre 4 y 40 caracteres: letras, números, espacios, guiones, puntos o barras.',
      );
      expect(MEMBER_NUMBER_DIGIT_MESSAGE).toBe(
        'El nº de afiliado o póliza debe tener al menos un número.',
      );
      expect(MEMBER_NUMBER_REPEATED_MESSAGE).toBe(
        'El nº de afiliado o póliza no puede ser un mismo carácter repetido.',
      );
      for (const message of [
        MEMBER_NUMBER_REQUIRED_MESSAGE,
        MEMBER_NUMBER_FORMAT_MESSAGE,
        MEMBER_NUMBER_DIGIT_MESSAGE,
        MEMBER_NUMBER_REPEATED_MESSAGE,
      ]) {
        expect(message).not.toMatch(/EPS|prepagada|mutua|documento|c[ée]dula/i);
      }
    });

    it('sin número, con cualquier pagador externo: obligatorio', () => {
      for (const type of EXTERNAL) {
        expect(memberNumberError(type, null)).toBe(
          MEMBER_NUMBER_REQUIRED_MESSAGE,
        );
      }
    });

    it('OTHER admite no tenerlo y cualquier texto', () => {
      expect(memberNumberError('OTHER', null)).toBeNull();
      expect(memberNumberError('OTHER', 'x')).toBeNull();
    });

    it('la misma regla para todo pagador externo', () => {
      const cases: [string, string | null][] = [
        ['1020304050', null],
        ['A123', null],
        ['10-123456-01', null],
        ['POL/2026/0042', null],
        ['1.020.304.050', null],
        ['EMP 001', null],
        ['Ñandú-77', null],
        [`1${'A'.repeat(39)}`, null],
        ['A12', MEMBER_NUMBER_FORMAT_MESSAGE],
        [`1${'A'.repeat(40)}`, MEMBER_NUMBER_FORMAT_MESSAGE],
        ['1234#5', MEMBER_NUMBER_FORMAT_MESSAGE],
        ['12_345', MEMBER_NUMBER_FORMAT_MESSAGE],
        ['EMPLEADO', MEMBER_NUMBER_DIGIT_MESSAGE],
        ['POL-ABC', MEMBER_NUMBER_DIGIT_MESSAGE],
        ['0000', MEMBER_NUMBER_REPEATED_MESSAGE],
        ['1111-1111', MEMBER_NUMBER_REPEATED_MESSAGE],
        ['aAaA1', null],
      ];
      for (const type of EXTERNAL) {
        for (const [value, expected] of cases) {
          expect([value, memberNumberError(type, value)]).toEqual([
            value,
            expected,
          ]);
        }
      }
    });

    it('ningún mensaje repite el número recibido', () => {
      for (const value of [
        '9988776655443322110099887766554433221100X',
        '9988#',
        'ABCDEFGH',
        '99999999',
      ]) {
        const message = memberNumberError('EMPLOYER', value);
        expect(message).not.toBeNull();
        expect(message).not.toContain(value.slice(0, 4));
      }
    });
  });

  describe('memberNumberLast4', () => {
    it('solo los 4 últimos caracteres alfanuméricos, sin separadores', () => {
      expect(memberNumberLast4('1.020.304.050')).toBe('4050');
      expect(memberNumberLast4('POL/2026/00-42')).toBe('0042');
      expect(memberNumberLast4('POL-Ñ123')).toBe('Ñ123');
      expect(memberNumberLast4(null)).toBeNull();
    });

    it('un número de 4 o menos no se revela entero', () => {
      expect(memberNumberLast4('A123')).toBeNull();
      expect(memberNumberLast4('12-34')).toBeNull();
    });
  });

  describe('memberNumberChanged', () => {
    it('compara lo normalizado: el mismo número con otros espacios no cambia', () => {
      expect(memberNumberChanged('10 20 30', '  10  20 30 ')).toBe(false);
      expect(memberNumberChanged('102030', '102031')).toBe(true);
      expect(memberNumberChanged(null, '102030')).toBe(true);
      expect(memberNumberChanged('102030', null)).toBe(true);
      expect(memberNumberChanged(null, null)).toBe(false);
    });
  });
});
