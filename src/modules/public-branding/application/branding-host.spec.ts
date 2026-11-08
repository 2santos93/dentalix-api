import { normalizeBrandingHost } from './branding-host';

describe('normalizeBrandingHost (DX-517-ter)', () => {
  it.each([
    ['sonrisa.dentalix.app', 'sonrisa.dentalix.app'],
    ['Sonrisa.Dentalix.APP', 'sonrisa.dentalix.app'],
    ['  sonrisa.localhost  ', 'sonrisa.localhost'],
    ['sonrisa.localhost:3001', 'sonrisa.localhost'],
    ['clinica-caracas.com.ve', 'clinica-caracas.com.ve'],
    ['clinica-caracas.com.ve.', 'clinica-caracas.com.ve'],
    ['clinica-caracas.com.ve.:443', 'clinica-caracas.com.ve'],
  ])('%p → %p (minúsculas, sin puerto ni punto final)', (raw, expected) => {
    expect(normalizeBrandingHost(raw)).toBe(expected);
  });

  it.each([
    ['vacío', ''],
    ['solo espacios', '   '],
    ['credenciales en la URL', 'demo.dentalix.app:443@evil.com'],
    ['etiqueta vacía', 'a..b'],
    ['byte nulo', 'demo.localhost\u0000.evil.com'],
    ['%00 sin decodificar', 'demo.localhost%00'],
    ['300 caracteres', `${'a'.repeat(296)}.com`],
    ['etiqueta de más de 63', `${'a'.repeat(64)}.com`],
    ['ruta', 'demo.localhost/admin'],
    ['query', 'demo.localhost?x=1'],
    ['fragmento', 'demo.localhost#x'],
    ['ampersand', 'demo.localhost&host=b.localhost'],
    ['dos puertos', 'demo.localhost:1:2'],
    ['puerto no numérico', 'demo.localhost:abc'],
    ['puerto fuera de rango', 'demo.localhost:70000'],
    ['guion al principio de la etiqueta', '-demo.localhost'],
    ['guion al final de la etiqueta', 'demo-.localhost'],
    ['IPv6', '[::1]'],
    ['espacio dentro', 'demo localhost'],
    ['no latino', 'clínica.com'],
    ['dos puntos finales', 'demo.localhost..'],
  ])('rechaza %s', (_label, raw) => {
    expect(normalizeBrandingHost(raw)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['número', 42],
    ['lista (host=a&host=b)', ['a.localhost', 'b.localhost']],
    ['objeto (host[x]=a)', { x: 'a.localhost' }],
  ])('rechaza lo que no es un texto: %s', (_label, raw) => {
    expect(normalizeBrandingHost(raw)).toBeNull();
  });
});
