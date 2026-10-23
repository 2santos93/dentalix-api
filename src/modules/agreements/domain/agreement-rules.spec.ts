import {
  AGREEMENT_DATE_FORMAT_MESSAGE,
  AGREEMENT_DATE_RANGE_MESSAGE,
  AGREEMENT_NAME_MESSAGE,
  AGREEMENT_PERCENT_FORBIDDEN_MESSAGE,
  AGREEMENT_PERCENT_RANGE_MESSAGE,
  AGREEMENT_PERCENT_REQUIRED_MESSAGE,
  AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE,
  AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE,
  agreementNameKey,
  agreementStatus,
  matchCategories,
  normalizeCategory,
  validateAgreementDates,
  validateAgreementName,
  validateAgreementShape,
} from './agreement-rules';

const LIST = '11111111-1111-4111-8111-111111111111';

describe('reglas de convenios (DX-105)', () => {
  describe('nombre', () => {
    it('2–120 caracteres tras normalizar espacios', () => {
      expect(validateAgreementName('Su')).toBeNull();
      expect(validateAgreementName('x'.repeat(120))).toBeNull();
      expect(validateAgreementName(' A ')).toBe(AGREEMENT_NAME_MESSAGE);
      expect(validateAgreementName('x'.repeat(121))).toBe(
        AGREEMENT_NAME_MESSAGE,
      );
    });

    it('la clave ignora mayúsculas, tildes y espacios de más', () => {
      expect(agreementNameKey('  Convenio   BOLÍVAR ')).toBe(
        agreementNameKey('convenio bolivar'),
      );
    });
  });

  describe('forma por kind', () => {
    const percent = {
      kind: 'PERCENT_DISCOUNT' as const,
      percent: 15,
      percentByCategory: null,
      priceListId: null,
    };
    const priceList = {
      kind: 'PRICE_LIST' as const,
      percent: null,
      percentByCategory: null,
      priceListId: LIST,
    };

    it('acepta cada kind con sus campos', () => {
      expect(validateAgreementShape(percent)).toBeNull();
      expect(
        validateAgreementShape({ ...percent, percentByCategory: { A: 5 } }),
      ).toBeNull();
      expect(validateAgreementShape(priceList)).toBeNull();
    });

    it('PERCENT_DISCOUNT pide porcentaje y no admite lista', () => {
      expect(validateAgreementShape({ ...percent, percent: null })).toBe(
        AGREEMENT_PERCENT_REQUIRED_MESSAGE,
      );
      expect(validateAgreementShape({ ...percent, priceListId: LIST })).toBe(
        AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE,
      );
    });

    it('el porcentaje va de 0 a 100, extremos incluidos', () => {
      for (const ok of [0, 0.01, 100]) {
        expect(validateAgreementShape({ ...percent, percent: ok })).toBeNull();
      }
      for (const bad of [-0.01, 100.01, Number.NaN]) {
        expect(validateAgreementShape({ ...percent, percent: bad })).toBe(
          AGREEMENT_PERCENT_RANGE_MESSAGE,
        );
      }
    });

    it('PRICE_LIST pide lista y no admite porcentajes', () => {
      expect(validateAgreementShape({ ...priceList, priceListId: null })).toBe(
        AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE,
      );
      expect(validateAgreementShape({ ...priceList, percent: 5 })).toBe(
        AGREEMENT_PERCENT_FORBIDDEN_MESSAGE,
      );
      expect(
        validateAgreementShape({ ...priceList, percentByCategory: { A: 5 } }),
      ).toBe(AGREEMENT_PERCENT_FORBIDDEN_MESSAGE);
    });
  });

  describe('categorías contra el catálogo', () => {
    const catalog = ['Operatoria', 'Cirugía oral', 'Prevención'];

    it('compara sin mayúsculas ni tildes y guarda la ortografía del catálogo', () => {
      const result = matchCategories(
        { operatoria: 10, ' CIRUGIA   ORAL ': 20, prevencion: 0 },
        catalog,
      );
      expect(result).toEqual({
        value: { Operatoria: 10, 'Cirugía oral': 20, Prevención: 0 },
        error: null,
      });
    });

    it('una categoría que no existe da el mensaje con su nombre', () => {
      expect(matchCategories({ Estética: 10 }, catalog)).toEqual({
        error: 'La categoría «Estética» no existe en el catálogo.',
      });
    });

    it('dos claves de la misma categoría se rechazan', () => {
      expect(
        matchCategories({ Operatoria: 10, operatoria: 20 }, catalog),
      ).toEqual({ error: 'La categoría «Operatoria» está repetida.' });
    });

    it('un porcentaje fuera de rango se rechaza', () => {
      expect(matchCategories({ Operatoria: 101 }, catalog)).toEqual({
        error: AGREEMENT_PERCENT_RANGE_MESSAGE,
      });
    });

    it('un catálogo sin categorías no casa con nada', () => {
      expect(matchCategories({ Operatoria: 10 }, [])).toEqual({
        error: 'La categoría «Operatoria» no existe en el catálogo.',
      });
    });

    it('normalizeCategory es la misma regla que el nombre', () => {
      expect(normalizeCategory(' Prevención ')).toBe('prevencion');
    });
  });

  describe('fechas', () => {
    it('acepta fechas reales, rango invertido y vacío', () => {
      expect(validateAgreementDates(null, null)).toBeNull();
      expect(validateAgreementDates('2026-01-01', '2026-01-01')).toBeNull();
      expect(validateAgreementDates('2026-01-01', null)).toBeNull();
      expect(validateAgreementDates('2026-02-01', '2026-01-01')).toBe(
        AGREEMENT_DATE_RANGE_MESSAGE,
      );
    });

    it('rechaza formatos y días que no existen', () => {
      for (const bad of ['01/02/2026', '2026-02-30', '2026-13-01']) {
        expect(validateAgreementDates(bad, null)).toBe(
          AGREEMENT_DATE_FORMAT_MESSAGE,
        );
      }
    });
  });

  describe('estado', () => {
    const open = { active: true, validFrom: null, validTo: null };

    it('ACTIVE sin vigencia o dentro de ella, extremos incluidos', () => {
      expect(agreementStatus(open, '2026-10-20')).toBe('ACTIVE');
      const range = {
        active: true,
        validFrom: '2026-10-20',
        validTo: '2026-10-20',
      };
      expect(agreementStatus(range, '2026-10-20')).toBe('ACTIVE');
    });

    it('EXPIRED y NOT_STARTED por fecha', () => {
      expect(
        agreementStatus({ ...open, validTo: '2026-10-19' }, '2026-10-20'),
      ).toBe('EXPIRED');
      expect(
        agreementStatus({ ...open, validFrom: '2026-10-21' }, '2026-10-20'),
      ).toBe('NOT_STARTED');
    });

    it('INACTIVE gana a la vigencia: desactivado o retirado', () => {
      expect(agreementStatus({ ...open, active: false }, '2026-10-20')).toBe(
        'INACTIVE',
      );
      expect(agreementStatus({ ...open, retired: true }, '2026-10-20')).toBe(
        'INACTIVE',
      );
      expect(
        agreementStatus(
          { active: false, validFrom: null, validTo: '2020-01-01' },
          '2026-10-20',
        ),
      ).toBe('INACTIVE');
    });
  });
});
