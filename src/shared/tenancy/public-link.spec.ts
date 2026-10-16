import { platformLinkHost, resolvePublicWebProtocol } from './public-link';

describe('resolvePublicWebProtocol', () => {
  const env =
    (values: Record<string, string>) =>
    (key: string): string | undefined =>
      values[key];

  it('respeta PUBLIC_WEB_PROTOCOL válido', () => {
    expect(
      resolvePublicWebProtocol(
        env({ PUBLIC_WEB_PROTOCOL: 'http', NODE_ENV: 'production' }),
      ),
    ).toBe('http');
  });

  it('sin valor (o uno inválido): https en producción, http en el resto', () => {
    expect(resolvePublicWebProtocol(env({ NODE_ENV: 'production' }))).toBe(
      'https',
    );
    expect(
      resolvePublicWebProtocol(
        env({ PUBLIC_WEB_PROTOCOL: 'ftp', NODE_ENV: 'development' }),
      ),
    ).toBe('http');
  });
});

describe('platformLinkHost (DX-029: enlace del registro)', () => {
  const BASES = ['dentalix.app', 'localhost'];

  it('acepta el dominio raíz y sus subdominios, con puerto', () => {
    expect(platformLinkHost('dentalix.app', BASES)).toBe('dentalix.app');
    expect(platformLinkHost('Demo.Dentalix.App', BASES)).toBe(
      'demo.dentalix.app',
    );
    expect(platformLinkHost('www.dentalix.app', BASES)).toBe(
      'www.dentalix.app',
    );
    expect(platformLinkHost('localhost:3000', BASES)).toBe('localhost:3000');
    expect(platformLinkHost('demo.localhost:3001', BASES)).toBe(
      'demo.localhost:3001',
    );
  });

  it('rechaza hosts ajenos (Host / X-Forwarded-Host inyectado) y dominios personalizados', () => {
    expect(platformLinkHost('evil.com', BASES)).toBeNull();
    expect(platformLinkHost('dentalix.app.evil.com', BASES)).toBeNull();
    expect(platformLinkHost('clinica-propia.com', BASES)).toBeNull();
    expect(platformLinkHost('127.0.0.1:3000', BASES)).toBeNull();
    expect(
      platformLinkHost('demo.dentalix.app:443@evil.com', BASES),
    ).toBeNull();
    expect(platformLinkHost(undefined, BASES)).toBeNull();
  });
});
