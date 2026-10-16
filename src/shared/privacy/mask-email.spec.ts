import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('deja 2 caracteres locales y el dominio', () => {
    expect(maskEmail('maria.lopez@clinica.co')).toBe('ma***@clinica.co');
  });

  it('un local corto no se completa', () => {
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });

  it('algo que no es un correo sale entero enmascarado', () => {
    expect(maskEmail('sin-arroba')).toBe('***');
    expect(maskEmail('@dominio.co')).toBe('***');
    expect(maskEmail('local@')).toBe('***');
  });
});
