import { buildConfirmationUrl, safeLinkHost } from './confirmation-url';

describe('buildConfirmationUrl', () => {
  it('usa el host de la clínica (con puerto) y el protocolo dado', () => {
    expect(buildConfirmationUrl('http', 'demo.localhost:3001', 'abc_-1')).toBe(
      'http://demo.localhost:3001/confirmar/abc_-1',
    );
    expect(buildConfirmationUrl('https', 'sonrisa.dentalix.app', 'tok')).toBe(
      'https://sonrisa.dentalix.app/confirmar/tok',
    );
  });
});

describe('safeLinkHost', () => {
  it('acepta nombre[:puerto] y lo normaliza a minúsculas', () => {
    expect(safeLinkHost('Sonrisa.Dentalix.App')).toBe('sonrisa.dentalix.app');
    expect(safeLinkHost('demo.localhost:3001')).toBe('demo.localhost:3001');
    expect(safeLinkHost('consultorio-ana.com')).toBe('consultorio-ana.com');
  });

  it.each([
    'demo.localhost:3001@evil.com',
    'demo.localhost:@evil.com',
    'demo.localhost:3001/evil',
    'demo.localhost:3001\\@evil.com',
    'demo.localhost:abc',
    'demo.localhost:3001#x',
    'demo.localhost:3001?x',
    'user@demo.localhost',
    '',
    undefined,
  ])('rechaza %p (null) en vez de armar un enlace a otro dominio', (host) => {
    expect(safeLinkHost(host)).toBeNull();
  });
});
