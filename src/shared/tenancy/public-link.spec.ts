import {
  platformLinkHost,
  resolvePublicWebProtocol,
  tenantLinkHost,
} from './public-link';

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

describe('tenantLinkHost (SEC-033: enlaces con token de la cuenta global)', () => {
  const BASES = ['dentalix.app', 'localhost'];

  it('petición por un host de plataforma: se usa ese mismo host (con puerto)', () => {
    expect(tenantLinkHost('demo.dentalix.app', 'demo', BASES)).toBe(
      'demo.dentalix.app',
    );
    expect(tenantLinkHost('Demo.Localhost:3001', 'demo', BASES)).toBe(
      'demo.localhost:3001',
    );
  });

  it('petición por un dominio personalizado: el subdominio de plataforma con el PRIMER dominio base, nunca el dominio propio ni su puerto', () => {
    expect(tenantLinkHost('clinica-propia.com', 'demo', BASES)).toBe(
      'demo.dentalix.app',
    );
    expect(tenantLinkHost('www.clinica-propia.com:8443', 'demo', BASES)).toBe(
      'demo.dentalix.app',
    );
    expect(tenantLinkHost('clinica-propia.com', 'demo', ['localhost'])).toBe(
      'demo.localhost',
    );
  });

  it('un host malformado o ausente tampoco se copia: va al subdominio de plataforma', () => {
    expect(
      tenantLinkHost('demo.dentalix.app:443@evil.com', 'demo', BASES),
    ).toBe('demo.dentalix.app');
    expect(tenantLinkHost(undefined, 'demo', BASES)).toBe('demo.dentalix.app');
  });

  it('sin subdominio válido o sin dominios base: null (no se envía el enlace)', () => {
    expect(tenantLinkHost('clinica-propia.com', null, BASES)).toBeNull();
    expect(tenantLinkHost('clinica-propia.com', '', BASES)).toBeNull();
    expect(
      tenantLinkHost('clinica-propia.com', 'a@evil.com', BASES),
    ).toBeNull();
    expect(tenantLinkHost('clinica-propia.com', 'x/y', BASES)).toBeNull();
    expect(tenantLinkHost('clinica-propia.com', 'demo', [])).toBeNull();
  });
});
