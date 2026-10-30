import { toE164Digits } from './e164';

describe('toE164Digits (DX-312)', () => {
  it('toE164Digits keeps + and 00 numbers and adds the default calling code otherwise', () => {
    // Con + ya es E.164: solo los dígitos, sea cual sea el indicativo por defecto.
    expect(toE164Digits('+57 310 555 0101', null)).toBe('573105550101');
    expect(toE164Digits('+52 (55) 1234-5678', '57')).toBe('525512345678');
    // 00 vale como +.
    expect(toE164Digits('0057 3105550101', null)).toBe('573105550101');
    // Sin +, se antepone el indicativo por defecto.
    expect(toE164Digits('310 555 0101', '57')).toBe('573105550101');
    expect(toE164Digits('55 1234 5678', '52')).toBe('525512345678');
    expect(toE164Digits('0412-1234567', '58')).toBe('584121234567');
    // Quita el 0 troncal antes del indicativo.
    expect(toE164Digits('011 1234 5678', '54')).toBe('541112345678');
    // No duplica el indicativo si ya viene escrito sin +.
    expect(toE164Digits('57 310 555 0101', '57')).toBe('573105550101');
  });

  it('without a default calling code, a number without + is null and the leading 0 is never stripped', () => {
    expect(toE164Digits('310 555 0101', null)).toBeNull();
    expect(toE164Digits('06 1234 5678', null)).toBeNull();
    expect(toE164Digits('+39 06 1234 5678', null)).toBe('390612345678');
  });

  it('null when the number is not plausible', () => {
    expect(toE164Digits(null, '57')).toBeNull();
    expect(toE164Digits('   ', '57')).toBeNull();
    expect(toE164Digits('+12', null)).toBeNull();
    expect(toE164Digits('+1234567890123456', null)).toBeNull();
    expect(toE164Digits('llamar a la mamá', '57')).toBeNull();
  });
});
