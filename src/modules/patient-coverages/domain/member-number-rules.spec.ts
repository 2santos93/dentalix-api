import {
  MEMBER_NUMBER_REPEATED_MESSAGE,
  memberNumberChanged,
  memberNumberError,
  memberNumberLast4,
  memberNumberRequiredMessage,
  normalizeMemberNumber,
  requiresMemberNumber,
} from './member-number-rules';

describe('nº de afiliado o póliza (SEC-049)', () => {
  describe('requiresMemberNumber', () => {
    it.each(['EPS_CO', 'PREPAGADA_CO', 'MUTUA_ES', 'EMPRESA'] as const)(
      '%s (pagador externo) lo exige',
      (type) => {
        expect(requiresMemberNumber(type)).toBe(true);
      },
    );

    it('OTRO (interno: cortesía, empleados) no', () => {
      expect(requiresMemberNumber('OTRO')).toBe(false);
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
    it('sin número, con un pagador externo: el mensaje dice qué tipo de pagador', () => {
      expect(memberNumberError('EPS_CO', null)).toBe(
        memberNumberRequiredMessage('EPS_CO'),
      );
      expect(memberNumberRequiredMessage('EPS_CO')).toBe(
        'En una EPS, el nº de afiliado es obligatorio: es el documento del afiliado.',
      );
      expect(memberNumberRequiredMessage('PREPAGADA_CO')).toBe(
        'En una prepagada, el nº de contrato o de afiliado es obligatorio.',
      );
      expect(memberNumberRequiredMessage('MUTUA_ES')).toBe(
        'En una mutua o aseguradora, el nº de póliza o de tarjeta es obligatorio.',
      );
      expect(memberNumberRequiredMessage('EMPRESA')).toBe(
        'En un convenio de empresa, el nº de empleado o de afiliado es obligatorio.',
      );
    });

    it('OTRO admite no tenerlo y cualquier texto', () => {
      expect(memberNumberError('OTRO', null)).toBeNull();
      expect(memberNumberError('OTRO', 'x')).toBeNull();
    });

    it('EPS: de 5 a 15 dígitos, con puntos, espacios o guiones de separador', () => {
      expect(memberNumberError('EPS_CO', '1020304050')).toBeNull();
      expect(memberNumberError('EPS_CO', '1.020.304.050')).toBeNull();
      expect(memberNumberError('EPS_CO', '52 123')).toBeNull();
      const message =
        'En una EPS, el nº de afiliado es el documento del afiliado: de 5 a 15 dígitos, sin letras.';
      expect(memberNumberError('EPS_CO', '1234')).toBe(message);
      expect(memberNumberError('EPS_CO', '1234567890123456')).toBe(message);
      expect(memberNumberError('EPS_CO', 'AB123456')).toBe(message);
      expect(memberNumberError('EPS_CO', '-123456')).toBe(message);
    });

    it('prepagada y mutua: de 5 a 30 caracteres con al menos 4 dígitos', () => {
      for (const type of ['PREPAGADA_CO', 'MUTUA_ES'] as const) {
        expect(memberNumberError(type, '10-123456-01')).toBeNull();
        expect(memberNumberError(type, 'POL/2026/0042')).toBeNull();
        const message = memberNumberError(type, 'ABC12');
        expect(message).toBe(
          'El nº de póliza o de contrato debe tener de 5 a 30 caracteres (letras, números, espacios, puntos, guiones o barras), con al menos 4 dígitos.',
        );
        expect(memberNumberError(type, 'A1')).toBe(message);
        expect(memberNumberError(type, `1234${'A'.repeat(27)}`)).toBe(message);
        expect(memberNumberError(type, '1234#5')).toBe(message);
      }
    });

    it('empresa: de 5 a 30 caracteres con al menos un dígito', () => {
      expect(memberNumberError('EMPRESA', 'EMP-001')).toBeNull();
      const message =
        'El nº de empleado o de afiliado debe tener de 5 a 30 caracteres (letras, números, espacios, puntos, guiones o barras), con al menos un dígito.';
      expect(memberNumberError('EMPRESA', 'EMPLEADO')).toBe(message);
      expect(memberNumberError('EMPRESA', 'E-1')).toBe(message);
    });

    it('un mismo carácter repetido no es un número', () => {
      expect(memberNumberError('EPS_CO', '00000')).toBe(
        MEMBER_NUMBER_REPEATED_MESSAGE,
      );
      expect(memberNumberError('MUTUA_ES', '1111-1111')).toBe(
        MEMBER_NUMBER_REPEATED_MESSAGE,
      );
    });

    it('ningún mensaje repite el número recibido', () => {
      const value = '99887766554433221100';
      for (const type of ['EPS_CO', 'PREPAGADA_CO', 'EMPRESA'] as const) {
        expect(memberNumberError(type, value) ?? '').not.toContain('9988');
      }
    });
  });

  describe('memberNumberLast4', () => {
    it('solo los 4 últimos caracteres alfanuméricos, sin separadores', () => {
      expect(memberNumberLast4('1.020.304.050')).toBe('4050');
      expect(memberNumberLast4('POL/2026/00-42')).toBe('0042');
      expect(memberNumberLast4(null)).toBeNull();
    });

    it('un número de 4 o menos no se revela entero', () => {
      expect(memberNumberLast4('1234')).toBeNull();
      expect(memberNumberLast4('A1')).toBeNull();
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
