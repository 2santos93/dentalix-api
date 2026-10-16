import { isAllowedOrigin, loadSecuritySettings } from './security-settings';

const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('loadSecuritySettings', () => {
  it('por defecto no confía en ningún proxy y mantiene los orígenes CORS actuales', () => {
    expect(loadSecuritySettings(envOf({}))).toEqual({
      trustProxyHops: 0,
      corsOrigins: ['http://localhost:3001'],
      corsRootDomain: 'dentalix.local',
    });
  });

  it('TRUST_PROXY=true confía en 1 salto (el proxy inmediato)', () => {
    expect(
      loadSecuritySettings(envOf({ TRUST_PROXY: 'true' })).trustProxyHops,
    ).toBe(1);
  });

  it('TRUST_PROXY_HOPS ajusta los saltos solo si TRUST_PROXY=true', () => {
    expect(
      loadSecuritySettings(
        envOf({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' }),
      ).trustProxyHops,
    ).toBe(2);
    expect(
      loadSecuritySettings(
        envOf({ TRUST_PROXY: 'false', TRUST_PROXY_HOPS: '2' }),
      ).trustProxyHops,
    ).toBe(0);
  });

  it('rechaza TRUST_PROXY_HOPS inválido', () => {
    expect(() =>
      loadSecuritySettings(
        envOf({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: 'x' }),
      ),
    ).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('parsea CORS_ORIGINS separados por coma', () => {
    const s = loadSecuritySettings(
      envOf({
        CORS_ORIGINS: 'https://a.com, https://b.com,,',
        CORS_ROOT_DOMAIN: 'dentalix.app',
      }),
    );
    expect(s.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
    expect(s.corsRootDomain).toBe('dentalix.app');
  });
});

describe('isAllowedOrigin', () => {
  const settings = loadSecuritySettings(
    envOf({
      CORS_ORIGINS: 'http://localhost:3001',
      CORS_ROOT_DOMAIN: 'dentalix.app',
    }),
  );

  it.each([
    'http://localhost:3001',
    'https://dentalix.app',
    'https://demo.dentalix.app',
  ])(
    'acepta %s (lista explícita, dominio raíz y sus subdominios)',
    (origin) => {
      expect(isAllowedOrigin(origin, settings)).toBe(true);
    },
  );

  it.each([
    'https://evil.example',
    'https://dentalix.app.evil.example',
    'https://evildentalix.app',
    'http://localhost:3002',
    'null',
    'no es una url',
  ])('rechaza %s', (origin) => {
    expect(isAllowedOrigin(origin, settings)).toBe(false);
  });
});
