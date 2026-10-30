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
    // Donde la numeración no distingue fijo de móvil, la librería lo da por móvil.
    ['+52 55 1234 5678', 'CO', '+525512345678'],
  ])('%j con %s → %s', (phone, region, e164) => {
    expect(normalizeMobile(phone, region)).toEqual({
      status: 'VALID',
      e164,
      ambiguous: false,
    });
  });

  it.each([
    [null, 'CO'],
    [undefined, 'CO'],
    ['', 'CO'],
    ['   ', 'ES'],
  ])('%j es MISSING', (phone, region) => {
    expect(normalizeMobile(phone, region)).toEqual({
      status: 'MISSING',
      e164: null,
      ambiguous: false,
    });
  });

  it.each([
    // Fijo: no es un móvil (no recibe WhatsApp).
    ['601 234 5678', 'CO'],
    ['+57 601 234 5678', 'CO'],
    ['91 123 45 67', 'ES'],
    ['+34 912 345 678', 'CO'],
    ['310 123 456', 'CO'],
    ['123', 'CO'],
    ['llamar a la mamá', 'CO'],
    // Sin `+` y sin región por defecto no se puede saber.
    ['3101234567', null],
  ])('%j con %s es INVALID', (phone, region) => {
    expect(normalizeMobile(phone, region)).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: false,
    });
  });

  it('normalizeMobile takes a region, never a country or a calling code', () => {
    expect(normalizeMobile('0412-1234567', 'VE')).toEqual({
      status: 'VALID',
      e164: '+584121234567',
      ambiguous: false,
    });
    expect(normalizeMobile('0212-5551234', 'VE')).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: false,
    });
    expect(normalizeMobile('0412-1234567', null)).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: false,
    });
    // Un indicativo no es una región: no se lee como tal.
    expect(normalizeMobile('0412-1234567', '58')).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: false,
    });
  });

  it('an ambiguous number is never VALID, never a wa.me and never stored as E.164', () => {
    expect(normalizeMobile('0058 412 1234567', 'CO')).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: true,
    });
    expect(normalizeMobile('49 151 23456789', 'DE')).toEqual({
      status: 'INVALID',
      e164: null,
      ambiguous: true,
    });
  });
});
