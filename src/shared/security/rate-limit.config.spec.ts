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
    // Enlace público de confirmación de cita (DX-005): por IP, como invitación.
    expect(cfg.confirmation).toEqual({ limit: 20, ttlMs: 60_000 });
    // Holgado: solo frena la fuerza bruta distribuida contra una cuenta.
    expect(cfg['login-account']).toEqual({ limit: 50, ttlMs: 60 * 60_000 });
    // DX-062: la web renueva en cada carga de página y una clínica entera sale
    // por UNA IP; el refresh es un JWT firmado (no se adivina), así que su
    // límite es holgado y va aparte del de login/register.
    expect(cfg.refresh).toEqual({ limit: 120, ttlMs: 60_000 });
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
        RATE_LIMIT_LOGIN_ACCOUNT_LIMIT: '9',
        RATE_LIMIT_LOGIN_ACCOUNT_TTL_MS: '5000',
        RATE_LIMIT_CONFIRMATION_LIMIT: '4',
        RATE_LIMIT_REFRESH_LIMIT: '30',
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
    expect(cfg['login-account']).toEqual({ limit: 9, ttlMs: 5000 });
    expect(cfg.confirmation).toEqual({
      ...DEFAULT_RATE_LIMITS.confirmation,
      limit: 4,
    });
    expect(cfg.refresh).toEqual({ ...DEFAULT_RATE_LIMITS.refresh, limit: 30 });
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
