import { normalizeMobile } from './mobile-number';

describe('normalizeMobile (DX-128)', () => {
  it.each([
    ['310 123 4567', '57', '+573101234567'],
    ['(310) 123-4567', '57', '+573101234567'],
    ['57 310 123 4567', '57', '+573101234567'],
    ['+57 310 123 4567', '34', '+573101234567'],
    ['0057 3101234567', null, '+573101234567'],
    ['612 34 56 78', '34', '+34612345678'],
    ['+34 712 345 678', '57', '+34712345678'],
    // Otro indicativo con `+`: solo se exige un largo E.164 plausible.
    ['+52 55 1234 5678', '57', '+525512345678'],
  ])('%j con %s → %s', (phone, callingCode, e164) => {
    expect(normalizeMobile(phone, callingCode)).toEqual({
      status: 'VALID',
      e164,
    });
  });

  it.each([
    [null, '57'],
    [undefined, '57'],
    ['', '57'],
    ['   ', '34'],
  ])('%j es MISSING', (phone, callingCode) => {
    expect(normalizeMobile(phone, callingCode)).toEqual({
      status: 'MISSING',
      e164: null,
    });
  });

  it.each([
    // Fijo con indicativo 57: no es un móvil (no recibe WhatsApp).
    ['601 234 5678', '57'],
    ['+57 601 234 5678', '57'],
    // Fijo con indicativo 34.
    ['91 123 45 67', '34'],
    ['+34 912 345 678', '57'],
    ['310 123 456', '57'],
    ['123', '57'],
    ['llamar a la mamá', '57'],
    // Sin `+` y sin indicativo por defecto no se puede saber.
    ['3101234567', null],
  ])('%j con %s es INVALID', (phone, callingCode) => {
    expect(normalizeMobile(phone, callingCode)).toEqual({
      status: 'INVALID',
      e164: null,
    });
  });

  it('normalizeMobile takes a calling code, never a country', () => {
    expect(normalizeMobile('0412-1234567', '58')).toEqual({
      status: 'VALID',
      e164: '+584121234567',
    });
    expect(normalizeMobile('3001234567', '57')).toEqual({
      status: 'VALID',
      e164: '+573001234567',
    });
    expect(normalizeMobile('0412-1234567', null)).toEqual({
      status: 'INVALID',
      e164: null,
    });
  });
});
