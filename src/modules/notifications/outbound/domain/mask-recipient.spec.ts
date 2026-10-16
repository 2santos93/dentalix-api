import { maskRecipient } from './mask-recipient';

describe('maskRecipient (DX-085)', () => {
  it('email: como el registro de envíos de DX-088', () => {
    expect(maskRecipient('EMAIL', 'ana.perez@clinica.co')).toBe(
      'an***@clinica.co',
    );
  });

  it('teléfono (WhatsApp y SMS): prefijo y los 4 últimos dígitos', () => {
    expect(maskRecipient('WHATSAPP_LINK', '+57 300 123 4567')).toBe(
      '+57***4567',
    );
    expect(maskRecipient('SMS', '3001234567')).toBe('30***4567');
  });

  it('algo que no parece un teléfono ni un email no se devuelve tal cual', () => {
    expect(maskRecipient('SMS', '12345')).toBe('***');
    expect(maskRecipient('EMAIL', 'sin-arroba')).toBe('***');
  });
});
