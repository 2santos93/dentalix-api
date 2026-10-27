import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  isRegionalError,
  normalizeLocale,
  validateHourCycle,
  validateRegionalSettings,
  validateTimeZone,
} from './regional-settings';

const KNOWN = new Set(['COP', 'EUR', 'JPY']);
const currencies: CurrencyWhitelist = {
  has: (code) => Promise.resolve(KNOWN.has(code)),
};
const valid = {
  currency: 'JPY',
  timeZone: 'Asia/Tokyo',
  locale: 'ja-JP',
  hourCycle: 'h23',
};

describe('validateRegionalSettings (G1)', () => {
  it('acepta moneda, zona, formato y reloj válidos', async () => {
    await expect(validateRegionalSettings(valid, currencies)).resolves.toEqual(
      valid,
    );
    await expect(
      validateRegionalSettings({ ...valid, hourCycle: 'h12' }, currencies),
    ).resolves.toEqual({ ...valid, hourCycle: 'h12' });
  });

  // G1-B fase 1 (spec §4.1, §4.3): la web de G1 no envía el reloj; lo
  // rellena la función de backfill, nunca este validador.
  it('sin reloj (forma de la web de G1) devuelve hourCycle null, sin inventarlo', async () => {
    for (const hourCycle of [undefined, null]) {
      await expect(
        validateRegionalSettings({ ...valid, hourCycle }, currencies),
      ).resolves.toEqual({ ...valid, hourCycle: null });
    }
  });

  it('valida el reloj después de moneda, zona y formato', async () => {
    await expect(
      validateRegionalSettings(
        { ...valid, locale: 'not a locale', hourCycle: 'h24' },
        currencies,
      ),
    ).resolves.toMatchObject({ field: 'locale' });
    await expect(
      validateRegionalSettings({ ...valid, hourCycle: 'h24' }, currencies),
    ).resolves.toEqual({
      field: 'hourCycle',
      message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
    });
  });

  it.each([
    [
      { ...valid, currency: undefined },
      'currency',
      'Elige la moneda de la sede.',
    ],
    [{ ...valid, currency: '  ' }, 'currency', 'Elige la moneda de la sede.'],
    [
      { ...valid, timeZone: undefined },
      'timeZone',
      'Elige la zona horaria de la sede.',
    ],
    [
      { ...valid, timeZone: null },
      'timeZone',
      'Elige la zona horaria de la sede.',
    ],
    [
      { ...valid, locale: undefined },
      'locale',
      'Elige el formato regional de la sede.',
    ],
    [
      { ...valid, locale: '' },
      'locale',
      'Elige el formato regional de la sede.',
    ],
  ])('falta un campo: %j', async (input, field, message) => {
    await expect(validateRegionalSettings(input, currencies)).resolves.toEqual({
      field,
      message,
    });
  });

  it('pasa la moneda a mayúsculas', async () => {
    await expect(
      validateRegionalSettings({ ...valid, currency: 'jpy' }, currencies),
    ).resolves.toMatchObject({ currency: 'JPY' });
  });

  it('rejects an unknown currency', async () => {
    await expect(
      validateRegionalSettings({ ...valid, currency: 'ZZZ' }, currencies),
    ).resolves.toEqual({
      field: 'currency',
      message: 'La moneda ZZZ no está en la lista de monedas admitidas.',
    });
    const malformed = await validateRegionalSettings(
      { ...valid, currency: 'JP' },
      currencies,
    );
    expect(isRegionalError(malformed) && malformed.field).toBe('currency');
  });

  it.each(['Mars/Olympus', 'Not/AZone'])('rejects %s', async (timeZone) => {
    await expect(
      validateRegionalSettings({ ...valid, timeZone }, currencies),
    ).resolves.toEqual({
      field: 'timeZone',
      message: `La zona horaria «${timeZone}» no existe.`,
    });
  });

  it("validateTimeZone('asia/kolkata') is Asia/Kolkata", () => {
    expect(validateTimeZone('asia/kolkata')).toBe('Asia/Kolkata');
  });

  it('ES-mx canonicalizes to es-MX', async () => {
    await expect(
      validateRegionalSettings({ ...valid, locale: 'ES-mx' }, currencies),
    ).resolves.toMatchObject({ locale: 'es-MX' });
  });

  it('rechaza un formato regional inválido', async () => {
    await expect(
      validateRegionalSettings(
        { ...valid, locale: 'not a locale' },
        currencies,
      ),
    ).resolves.toEqual({
      field: 'locale',
      message: 'El formato regional «not a locale» no es válido.',
    });
  });
});

describe('validateHourCycle (G1-B)', () => {
  it('hourCycle missing and invalid give the §4.1 messages', () => {
    for (const raw of [undefined, null, '', '  ']) {
      expect(validateHourCycle(raw)).toEqual({
        field: 'hourCycle',
        message: 'Elige el reloj de la sede: 12 h o 24 h.',
      });
    }
    for (const raw of ['h24', 'h11', 'H12', '12']) {
      expect(validateHourCycle(raw)).toEqual({
        field: 'hourCycle',
        message: `El reloj «${raw}» no es válido: elige 12 h o 24 h.`,
      });
    }
    expect(validateHourCycle('h12')).toBe('h12');
    expect(validateHourCycle(' h23 ')).toBe('h23');
  });
});

describe('normalizeLocale', () => {
  it('normalizeLocale strips the hc keyword: en-US-u-hc-h12 → en-US', () => {
    expect(normalizeLocale('en-US-u-hc-h12')).toBe('en-US');
    expect(normalizeLocale('DE-de-U-HC-H23')).toBe('de-DE');
    // Las demás palabras clave se conservan (spec §3.2).
    expect(normalizeLocale('ja-JP-u-ca-japanese-hc-h12')).toBe(
      'ja-JP-u-ca-japanese',
    );
    expect(normalizeLocale('fr-FR-u-hc-h23-nu-latn')).toBe('fr-FR-u-nu-latn');
    expect(normalizeLocale('pt-BR-u-nu-latn')).toBe('pt-BR-u-nu-latn');
  });

  it('canonicaliza y devuelve null si no es válido', () => {
    expect(normalizeLocale('ES-mx')).toBe('es-MX');
    expect(normalizeLocale('ja-JP')).toBe('ja-JP');
    expect(normalizeLocale('x')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
  });

  it('rechaza un formato de más de 35 caracteres (el CHECK de la BD)', () => {
    const long = 'es-ES-u-ca-gregory-co-standard-nu-latn-fw-mon';
    expect(Intl.getCanonicalLocales(long)[0].length).toBeGreaterThan(35);
    expect(normalizeLocale(long)).toBeNull();
  });
});
