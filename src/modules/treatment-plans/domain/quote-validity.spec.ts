import {
  isQuoteExpired,
  isValidQuoteValidityDays,
  issueQuoteValidity,
  PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS,
  QUOTE_VALIDITY_DAYS_MAX,
  QUOTE_VALIDITY_DAYS_MESSAGE,
  QUOTE_VALIDITY_DAYS_MIN,
  quoteSettingsCode,
  quoteValidityDays,
  storedQuoteValidity,
} from './quote-validity';

const CARACAS = 'America/Caracas'; // UTC−4 todo el año

describe('ajuste de validez del presupuesto (DX-379)', () => {
  it('30 días de plataforma, de 1 a 365', () => {
    expect(PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS).toBe(30);
    expect(QUOTE_VALIDITY_DAYS_MIN).toBe(1);
    expect(QUOTE_VALIDITY_DAYS_MAX).toBe(365);
    expect(QUOTE_VALIDITY_DAYS_MESSAGE).toBe(
      'La validez del presupuesto tiene que ser un número entero de días entre 1 y 365.',
    );
  });

  it.each([1, 30, 365])('admite %p', (days) => {
    expect(isValidQuoteValidityDays(days)).toBe(true);
  });

  it.each([0, 366, -1, 1.5, '30', null, undefined, Number.NaN])(
    'rechaza %p',
    (days) => {
      expect(isValidQuoteValidityDays(days)).toBe(false);
    },
  );

  it('código de auditoría QT_V{días}', () => {
    expect(quoteSettingsCode({ validityDays: 30 })).toBe('QT_V30');
    expect(quoteSettingsCode({ validityDays: 365 })).toBe('QT_V365');
  });
});

describe('issueQuoteValidity (DX-379)', () => {
  it('emitido hoy en la zona de la sede, vence hoy + días', () => {
    expect(
      issueQuoteValidity(new Date('2026-11-09T15:00:00Z'), CARACAS, 30),
    ).toEqual({ issuedOn: '2026-11-09', validUntil: '2026-12-09' });
  });

  it('a las 23:30 de Caracas (03:30 UTC del día siguiente) sigue siendo hoy en la sede', () => {
    expect(
      issueQuoteValidity(new Date('2026-11-10T03:30:00Z'), CARACAS, 15),
    ).toEqual({ issuedOn: '2026-11-09', validUntil: '2026-11-24' });
  });

  it('cruza el fin de año', () => {
    expect(
      issueQuoteValidity(new Date('2026-12-20T12:00:00Z'), CARACAS, 30),
    ).toEqual({ issuedOn: '2026-12-20', validUntil: '2027-01-19' });
  });

  it('rechaza unos días fuera del ajuste', () => {
    expect(() =>
      issueQuoteValidity(new Date('2026-11-09T15:00:00Z'), CARACAS, 0),
    ).toThrow(RangeError);
  });
});

describe('quoteValidityDays', () => {
  it('días entre la emisión y el vencimiento', () => {
    expect(
      quoteValidityDays({ issuedOn: '2026-11-09', validUntil: '2026-12-09' }),
    ).toBe(30);
    expect(
      quoteValidityDays({ issuedOn: '2026-12-31', validUntil: '2027-01-01' }),
    ).toBe(1);
  });
});

describe('storedQuoteValidity', () => {
  it('las dos fechas guardadas, o null si falta alguna', () => {
    expect(
      storedQuoteValidity({
        quoteIssuedOn: '2026-11-09',
        quoteValidUntil: '2026-12-09',
      }),
    ).toEqual({ issuedOn: '2026-11-09', validUntil: '2026-12-09' });
    expect(
      storedQuoteValidity({ quoteIssuedOn: null, quoteValidUntil: null }),
    ).toBeNull();
  });
});

describe('isQuoteExpired (DX-379, D-13)', () => {
  it('sin fecha guardada nunca vence (planes anteriores a DX-379)', () => {
    expect(
      isQuoteExpired(null, new Date('2030-01-01T00:00:00Z'), CARACAS),
    ).toBe(false);
  });

  it('el día del vencimiento todavía vale; vence al día siguiente', () => {
    expect(
      isQuoteExpired('2026-12-09', new Date('2026-12-09T20:00:00Z'), CARACAS),
    ).toBe(false);
    expect(
      isQuoteExpired('2026-12-09', new Date('2026-12-10T12:00:00Z'), CARACAS),
    ).toBe(true);
  });

  it('borde de medianoche en Caracas: a las 23:59 aún vale aunque en UTC ya sea el día siguiente', () => {
    // 2026-12-10T03:59Z = 2026-12-09 23:59 en Caracas.
    expect(
      isQuoteExpired('2026-12-09', new Date('2026-12-10T03:59:00Z'), CARACAS),
    ).toBe(false);
    // 2026-12-10T04:00Z = 2026-12-10 00:00 en Caracas: ya vencido.
    expect(
      isQuoteExpired('2026-12-09', new Date('2026-12-10T04:00:00Z'), CARACAS),
    ).toBe(true);
  });
});
