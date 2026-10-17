import { maskDocument } from './mask-document';

describe('maskDocument (DX-136)', () => {
  it('un documento largo deja ver solo los 4 últimos caracteres', () => {
    expect(maskDocument('1012345678')).toBe('******5678');
  });

  it('uno de 5 a 7 caracteres deja ver solo los 2 últimos', () => {
    expect(maskDocument('AB12345')).toBe('*****45');
    expect(maskDocument('12345')).toBe('***45');
  });

  it('uno de 4 o menos no deja ver nada', () => {
    expect(maskDocument('1234')).toBe('****');
    expect(maskDocument('9')).toBe('*');
  });

  it('ignora los espacios de los extremos', () => {
    expect(maskDocument('  1012345678 ')).toBe('******5678');
  });

  it('sin documento devuelve null', () => {
    expect(maskDocument(null)).toBeNull();
    expect(maskDocument('   ')).toBeNull();
  });
});
