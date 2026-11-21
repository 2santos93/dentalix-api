import {
  NO_CLINIC_CURRENCIES,
  applyClinicCurrenciesPatch,
  currencyNotAccepted,
  headerCurrencies,
  isAcceptedCurrency,
  patchCurrencyCodes,
  perReference,
  type ClinicCurrencies,
} from './clinic-currencies';

const CATALOG = new Set([
  'USD',
  'VES',
  'EUR',
  'GBP',
  'MXN',
  'PEN',
  'BRL',
  'ARS',
  'CLP',
]);
const catalog = (locationCurrencies: string[] = ['VES']) => ({
  isKnown: (code: string) => CATALOG.has(code),
  locationCurrencies,
});

describe('Monedas de la clínica (DX-584)', () => {
  describe('applyClinicCurrenciesPatch', () => {
    it('normaliza a mayúsculas y conserva el orden del ADMIN', () => {
      expect(
        applyClinicCurrenciesPatch(
          NO_CLINIC_CURRENCIES,
          { acceptedCurrencies: [' usd', 'VES'], rateReferenceCurrency: 'ves' },
          catalog(),
        ),
      ).toEqual({
        ok: true,
        value: {
          acceptedCurrencies: ['USD', 'VES'],
          rateReferenceCurrency: 'VES',
          showRateInHeader: null,
        },
      });
    });

    it('un campo que no llega se conserva', () => {
      const current: ClinicCurrencies = {
        acceptedCurrencies: ['USD', 'VES'],
        rateReferenceCurrency: 'VES',
        showRateInHeader: true,
      };
      expect(
        applyClinicCurrenciesPatch(
          current,
          { showRateInHeader: null },
          catalog(),
        ),
      ).toEqual({ ok: true, value: { ...current, showRateInHeader: null } });
    });

    it('rechaza una moneda que no está en el catálogo, con el código en el mensaje', () => {
      const result = applyClinicCurrenciesPatch(
        NO_CLINIC_CURRENCIES,
        { acceptedCurrencies: ['USD', 'XXX'] },
        catalog(),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain('XXX');
    });

    it('rechaza repetidas y más de 8', () => {
      expect(
        applyClinicCurrenciesPatch(
          NO_CLINIC_CURRENCIES,
          { acceptedCurrencies: ['USD', 'usd'] },
          catalog(),
        ),
      ).toEqual({
        ok: false,
        message: 'USD aparece más de una vez en las monedas aceptadas.',
      });
      expect(
        applyClinicCurrenciesPatch(
          NO_CLINIC_CURRENCIES,
          {
            acceptedCurrencies: [
              'USD',
              'VES',
              'EUR',
              'GBP',
              'MXN',
              'PEN',
              'BRL',
              'ARS',
              'CLP',
            ],
          },
          catalog(),
        ),
      ).toEqual({
        ok: false,
        message: 'La clínica puede aceptar 8 monedas como mucho.',
      });
    });

    it('la referencia tiene que ser aceptada o de alguna sede', () => {
      expect(
        applyClinicCurrenciesPatch(
          NO_CLINIC_CURRENCIES,
          { acceptedCurrencies: ['USD'], rateReferenceCurrency: 'EUR' },
          catalog(['VES']),
        ),
      ).toEqual({
        ok: false,
        message:
          'La moneda de referencia (EUR) tiene que ser una de las monedas aceptadas o la moneda de alguna sede.',
      });
      // La de una sede sirve aunque no se acepte.
      expect(
        applyClinicCurrenciesPatch(
          NO_CLINIC_CURRENCIES,
          { acceptedCurrencies: ['USD'], rateReferenceCurrency: 'VES' },
          catalog(['VES']),
        ).ok,
      ).toBe(true);
    });

    it('valida el resultado: quitar de las aceptadas la referencia que no es de ninguna sede da 400', () => {
      const current: ClinicCurrencies = {
        acceptedCurrencies: ['USD', 'EUR'],
        rateReferenceCurrency: 'EUR',
        showRateInHeader: null,
      };
      expect(
        applyClinicCurrenciesPatch(
          current,
          { acceptedCurrencies: ['USD'] },
          catalog(['VES']),
        ).ok,
      ).toBe(false);
      // Quitar la referencia a la vez sí vale.
      expect(
        applyClinicCurrenciesPatch(
          current,
          { acceptedCurrencies: ['USD'], rateReferenceCurrency: null },
          catalog(['VES']),
        ),
      ).toEqual({
        ok: true,
        value: {
          acceptedCurrencies: ['USD'],
          rateReferenceCurrency: null,
          showRateInHeader: null,
        },
      });
    });

    it('patchCurrencyCodes junta aceptadas y referencia, normalizadas y sin repetir', () => {
      expect(
        patchCurrencyCodes({
          acceptedCurrencies: ['usd', 'VES'],
          rateReferenceCurrency: 'ves',
        }),
      ).toEqual(['USD', 'VES']);
    });
  });

  it('lista vacía acepta cualquier moneda; con lista, solo las suyas', () => {
    expect(isAcceptedCurrency({ acceptedCurrencies: [] }, 'EUR')).toBe(true);
    expect(isAcceptedCurrency({ acceptedCurrencies: ['USD'] }, 'USD')).toBe(
      true,
    );
    expect(isAcceptedCurrency({ acceptedCurrencies: ['USD'] }, 'EUR')).toBe(
      false,
    );
    expect(currencyNotAccepted('EUR').getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'CURRENCY_NOT_ACCEPTED',
      message:
        'Esta clínica no acepta pagos en EUR. Cambia las monedas en Ajustes.',
      currency: 'EUR',
    });
  });

  describe('headerCurrencies', () => {
    const base = { ...NO_CLINIC_CURRENCIES };
    it('las aceptadas menos la de referencia, en su orden', () => {
      expect(
        headerCurrencies(
          { ...base, acceptedCurrencies: ['EUR', 'VES', 'USD'] },
          'VES',
        ),
      ).toEqual(['EUR', 'USD']);
    });
    it('sin aceptadas: nada en automático; USD si el ADMIN fuerza «Siempre»', () => {
      expect(headerCurrencies(base, 'VES')).toEqual([]);
      expect(
        headerCurrencies({ ...base, showRateInHeader: true }, 'VES'),
      ).toEqual(['USD']);
      expect(
        headerCurrencies({ ...base, showRateInHeader: true }, 'USD'),
      ).toEqual([]);
    });
  });

  describe('perReference (cruce vía USD)', () => {
    const rates = { VES: 918.77, EUR: 0.92 };
    it('USD contra VES es la tasa del VES', () => {
      expect(perReference(rates, 'USD', 'VES')).toBe(918.77);
    });
    it('EUR contra VES cruza por USD', () => {
      expect(perReference(rates, 'EUR', 'VES')).toBe(
        Number((918.77 / 0.92).toFixed(8)),
      );
    });
    it('VES contra USD es la inversa', () => {
      expect(perReference(rates, 'VES', 'USD')).toBe(
        Number((1 / 918.77).toFixed(8)),
      );
    });
    it('sin alguna de las dos tasas, null', () => {
      expect(perReference(rates, 'GBP', 'VES')).toBeNull();
      expect(perReference({ EUR: 0.92 }, 'USD', 'VES')).toBeNull();
    });
  });
});
