import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  isRegionalError,
  normalizeLocale,
  validateRegionalSettings,
} from './regional-settings';

const KNOWN = new Set(['COP', 'EUR', 'JPY']);
const currencies: CurrencyWhitelist = {
  has: (code) => Promise.resolve(KNOWN.has(code)),
};
const valid = { currency: 'JPY', timeZone: 'Asia/Tokyo', locale: 'ja-JP' };

describe('validateRegionalSettings (G1)', () => {
  it('acepta moneda, zona y formato válidos', async () => {
    await expect(validateRegionalSettings(valid, currencies)).resolves.toEqual(
      valid,
    );
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

describe('normalizeLocale', () => {
  it('canonicaliza y devuelve null si no es válido', () => {
    expect(normalizeLocale('ES-mx')).toBe('es-MX');
    expect(normalizeLocale('ja-JP')).toBe('ja-JP');
    expect(normalizeLocale('x')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
  });
});
