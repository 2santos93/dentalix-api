import { toWhatsAppNumber } from './whatsapp-phone';

describe('toWhatsAppNumber', () => {
  it('un número con + ya es E.164: deja solo los dígitos', () => {
    expect(toWhatsAppNumber('+57 310 555 0101', null)).toBe('573105550101');
    expect(toWhatsAppNumber('+52 (55) 1234-5678', 'CO')).toBe('525512345678');
  });

  it('acepta el prefijo internacional 00 como +', () => {
    expect(toWhatsAppNumber('0057 3105550101', null)).toBe('573105550101');
  });

  it('sin +, antepone el indicativo del país del paciente', () => {
    expect(toWhatsAppNumber('310 555 0101', 'CO')).toBe('573105550101');
    expect(toWhatsAppNumber('55 1234 5678', 'MX')).toBe('525512345678');
  });

  it('quita el 0 troncal nacional antes del indicativo', () => {
    expect(toWhatsAppNumber('011 1234 5678', 'AR')).toBe('541112345678');
  });

  it('no duplica el indicativo si ya viene escrito sin +', () => {
    expect(toWhatsAppNumber('57 310 555 0101', 'CO')).toBe('573105550101');
  });

  it('null si no hay forma de saber el país o el número no es plausible', () => {
    expect(toWhatsAppNumber('310 555 0101', null)).toBeNull();
    expect(toWhatsAppNumber('310 555 0101', 'ZZ')).toBeNull();
    expect(toWhatsAppNumber(null, 'CO')).toBeNull();
    expect(toWhatsAppNumber('   ', 'CO')).toBeNull();
    expect(toWhatsAppNumber('+12', null)).toBeNull();
    expect(toWhatsAppNumber('+1234567890123456', null)).toBeNull();
    expect(toWhatsAppNumber('llamar a la mamá', 'CO')).toBeNull();
  });
});
