import {
  VerifiedDomainLookup,
  customDomainHostOf,
  isAllowedOrigin,
  isStaticAllowedOrigin,
  loadSecuritySettings,
} from './security-settings';

const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('loadSecuritySettings', () => {
  it('por defecto no confía en ningún proxy y mantiene los orígenes CORS actuales', () => {
    expect(loadSecuritySettings(envOf({}))).toEqual({
      trustProxyHops: 0,
      production: false,
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

  it('SEC-021: en producción no hay defaults (sin CORS_ROOT_DOMAIN no arranca; sin CORS_ORIGINS, lista vacía)', () => {
    expect(() =>
      loadSecuritySettings(envOf({ NODE_ENV: 'production' })),
    ).toThrow(/CORS_ROOT_DOMAIN/);
    const s = loadSecuritySettings(
      envOf({ NODE_ENV: 'production', CORS_ROOT_DOMAIN: 'Dentalix.App ' }),
    );
    expect(s).toMatchObject({
      production: true,
      corsOrigins: [],
      corsRootDomain: 'dentalix.app',
    });
  });
});

/** Lookup simulado: los hosts VERIFIED y las consultas hechas. */
function lookupOf(verified: string[]): VerifiedDomainLookup & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    isVerified: (host) => {
      asked.push(host);
      return Promise.resolve(verified.includes(host));
    },
  };
}

// Los dominios propios: uno VERIFIED; `citas.pendiente.com` está PENDING y
// `citas.desconocido.com` no existe (para el lookup, ambos son «no VERIFIED»:
// la distinción de estados la prueba el int de VerifiedDomainOrigins).
const VERIFIED = 'citas.miclinica.com';

describe('isAllowedOrigin (SEC-021) en PRODUCCIÓN', () => {
  const prod = loadSecuritySettings(
    envOf({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://dentalix.app,https://admin.dentalix.app:8443',
      CORS_ROOT_DOMAIN: 'dentalix.app',
    }),
  );

  it.each([
    ['https://dentalix.app', 'raíz https'],
    ['https://demo.dentalix.app', 'subdominio https'],
    ['https://a.b.dentalix.app', 'subdominio anidado'],
    ['https://admin.dentalix.app:8443', 'exacto de CORS_ORIGINS con puerto'],
    [`https://${VERIFIED}`, 'dominio propio VERIFIED'],
  ])('acepta %s (%s)', async (origin) => {
    await expect(
      isAllowedOrigin(origin, prod, lookupOf([VERIFIED])),
    ).resolves.toBe(true);
  });

  it.each([
    ['http://demo.dentalix.app', 'subdominio http'],
    ['http://dentalix.app', 'raíz http'],
    ['https://demo.dentalix.app:8443', 'subdominio con puerto no estándar'],
    ['https://dentalix.app:444', 'raíz con puerto no estándar'],
    [
      'https://demo.dentalix.app:443',
      'puerto 443 explícito (no es un Origin real)',
    ],
    ['https://citas.pendiente.com', 'dominio propio PENDING'],
    ['https://citas.desconocido.com', 'dominio desconocido'],
    [`http://${VERIFIED}`, 'dominio propio VERIFIED por http'],
    [`https://${VERIFIED}:8443`, 'dominio propio VERIFIED con puerto'],
    ['https://dentalix.app.evil.example', 'sufijo engañoso'],
    ['https://evildentalix.app', 'raíz sin punto'],
    ['https://demo.dentalix.app/ruta', 'con ruta'],
    ['https://user@demo.dentalix.app', 'con credenciales'],
    ['http://localhost:3001', 'default de desarrollo'],
    ['http://demo.localhost:3001', 'web de desarrollo'],
    ['null', 'Origin null'],
    ['no es una url', 'basura'],
  ])('rechaza %s (%s)', async (origin) => {
    await expect(
      isAllowedOrigin(origin, prod, lookupOf([VERIFIED])),
    ).resolves.toBe(false);
  });

  it('solo consulta la BD para candidatos a dominio propio (https, puerto estándar, fuera del raíz)', async () => {
    const lookup = lookupOf([VERIFIED]);
    for (const origin of [
      'https://demo.dentalix.app',
      'http://citas.otra.com',
      'https://citas.otra.com:8443',
      'null',
      'https://Citas.Otra.com',
    ]) {
      await isAllowedOrigin(origin, prod, lookup);
    }
    expect(lookup.asked).toEqual(['citas.otra.com']);
  });

  it('sin lookup (app sin BD) solo vale la regla estática', async () => {
    await expect(
      isAllowedOrigin(`https://${VERIFIED}`, prod, null),
    ).resolves.toBe(false);
    await expect(
      isAllowedOrigin('https://demo.dentalix.app', prod, null),
    ).resolves.toBe(true);
  });

  it('un fallo del lookup se propaga (no se deja pasar)', async () => {
    const failing: VerifiedDomainLookup = {
      isVerified: () => Promise.reject(new Error('db down')),
    };
    await expect(
      isAllowedOrigin(`https://${VERIFIED}`, prod, failing),
    ).rejects.toThrow('db down');
  });

  it('customDomainHostOf: solo https con puerto estándar y fuera del raíz', () => {
    expect(customDomainHostOf('https://Citas.MiClinica.com', prod)).toBe(
      'citas.miclinica.com',
    );
    expect(customDomainHostOf('https://demo.dentalix.app', prod)).toBeNull();
    expect(customDomainHostOf('http://citas.miclinica.com', prod)).toBeNull();
    expect(
      customDomainHostOf('https://citas.miclinica.com:8443', prod),
    ).toBeNull();
  });
});

describe('isAllowedOrigin en DESARROLLO', () => {
  const dev = loadSecuritySettings(
    envOf({
      CORS_ORIGINS: 'http://localhost:3001',
      CORS_ROOT_DOMAIN: 'localhost',
    }),
  );

  it.each([
    'http://localhost:3001',
    'http://demo.localhost:3001',
    'http://otra.localhost:3001',
    'https://demo.localhost',
    `https://${VERIFIED}`,
  ])('acepta %s', async (origin) => {
    await expect(
      isAllowedOrigin(origin, dev, lookupOf([VERIFIED])),
    ).resolves.toBe(true);
  });

  it.each([
    'https://citas.pendiente.com',
    'https://citas.desconocido.com',
    `http://${VERIFIED}`,
    'https://evil.example',
    'https://localhost.evil.example',
    'null',
  ])('rechaza %s', async (origin) => {
    await expect(
      isAllowedOrigin(origin, dev, lookupOf([VERIFIED])),
    ).resolves.toBe(false);
  });
});

describe('isStaticAllowedOrigin', () => {
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
    // Fuera de producción el esquema y el puerto no se miran.
    'http://demo.dentalix.app:8080',
  ])(
    'acepta %s (lista explícita, dominio raíz y sus subdominios)',
    (origin) => {
      expect(isStaticAllowedOrigin(origin, settings)).toBe(true);
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
    expect(isStaticAllowedOrigin(origin, settings)).toBe(false);
  });
});
