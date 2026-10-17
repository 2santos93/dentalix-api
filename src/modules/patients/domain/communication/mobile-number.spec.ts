import { normalizeMobile } from './mobile-number';

describe('normalizeMobile (DX-128)', () => {
  it.each([
    ['310 123 4567', 'CO', '+573101234567'],
    ['(310) 123-4567', 'CO', '+573101234567'],
    ['57 310 123 4567', 'CO', '+573101234567'],
    ['+57 310 123 4567', 'ES', '+573101234567'],
    ['0057 3101234567', null, '+573101234567'],
    ['612 34 56 78', 'ES', '+34612345678'],
    ['+34 712 345 678', 'CO', '+34712345678'],
    // Otro país con `+`: solo se exige un largo E.164 plausible.
    ['+52 55 1234 5678', 'CO', '+525512345678'],
  ])('%j en %s → %s', (phone, country, e164) => {
    expect(normalizeMobile(phone, country)).toEqual({ status: 'VALID', e164 });
  });

  it.each([
    [null, 'CO'],
    [undefined, 'CO'],
    ['', 'CO'],
    ['   ', 'ES'],
  ])('%j es MISSING', (phone, country) => {
    expect(normalizeMobile(phone, country)).toEqual({
      status: 'MISSING',
      e164: null,
    });
  });

  it.each([
    // Fijo de Bogotá: no es un móvil (no recibe WhatsApp).
    ['601 234 5678', 'CO'],
    ['+57 601 234 5678', 'CO'],
    // Fijo de Madrid.
    ['91 123 45 67', 'ES'],
    ['+34 912 345 678', 'CO'],
    ['310 123 456', 'CO'],
    ['123', 'CO'],
    ['llamar a la mamá', 'CO'],
    // Sin `+` y sin país no se puede saber el indicativo.
    ['3101234567', null],
  ])('%j en %s es INVALID', (phone, country) => {
    expect(normalizeMobile(phone, country)).toEqual({
      status: 'INVALID',
      e164: null,
    });
  });
});
