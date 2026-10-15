import { DEFAULT_RATE_LIMITS, loadRateLimitConfig } from './rate-limit.config';

const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('loadRateLimitConfig', () => {
  it('usa defaults seguros cuando no hay variables', () => {
    const cfg = loadRateLimitConfig(envOf({}));
    expect(cfg).toEqual(DEFAULT_RATE_LIMITS);
    // Los límites de credenciales son estrictos por defecto.
    expect(cfg.login).toEqual({ limit: 5, ttlMs: 15 * 60_000 });
    expect(cfg.password).toEqual({ limit: 5, ttlMs: 15 * 60_000 });
    expect(cfg.auth.limit).toBeLessThanOrEqual(20);
    expect(cfg.invitation.limit).toBeLessThanOrEqual(10);
  });

  it('lee límite y ventana de cada política desde el entorno', () => {
    const cfg = loadRateLimitConfig(
      envOf({
        RATE_LIMIT_GLOBAL_LIMIT: '50',
        RATE_LIMIT_GLOBAL_TTL_MS: '1000',
        RATE_LIMIT_LOGIN_LIMIT: '3',
        RATE_LIMIT_LOGIN_TTL_MS: '30000',
        RATE_LIMIT_AUTH_LIMIT: '7',
        RATE_LIMIT_INVITATION_TTL_MS: '120000',
        RATE_LIMIT_PASSWORD_LIMIT: '2',
      }),
    );
    expect(cfg.global).toEqual({ limit: 50, ttlMs: 1000 });
    expect(cfg.login).toEqual({ limit: 3, ttlMs: 30000 });
    expect(cfg.auth).toEqual({ ...DEFAULT_RATE_LIMITS.auth, limit: 7 });
    expect(cfg.invitation).toEqual({
      ...DEFAULT_RATE_LIMITS.invitation,
      ttlMs: 120000,
    });
    expect(cfg.password.limit).toBe(2);
  });

  it('trata la cadena vacía como "no definida"', () => {
    const cfg = loadRateLimitConfig(envOf({ RATE_LIMIT_LOGIN_LIMIT: '' }));
    expect(cfg.login).toEqual(DEFAULT_RATE_LIMITS.login);
  });

  it.each(['0', '-1', 'abc', '1.5', '10req'])(
    'rechaza al arrancar un valor inválido (%s)',
    (value) => {
      expect(() =>
        loadRateLimitConfig(envOf({ RATE_LIMIT_LOGIN_LIMIT: value })),
      ).toThrow(/RATE_LIMIT_LOGIN_LIMIT/);
    },
  );
});
