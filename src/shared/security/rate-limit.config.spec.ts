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
    // DX-048: login-burst solo frena avalanchas por IP (cuenta también los
    // aciertos), holgado para una clínica entera tras NAT. La fuerza bruta la
    // corta el bloqueo por FALLOS de la BD (login-lockout.ts).
    expect(cfg['login-burst']).toEqual({ limit: 60, ttlMs: 60_000 });
    expect(cfg.password).toEqual({ limit: 5, ttlMs: 15 * 60_000 });
    expect(cfg.auth.limit).toBeLessThanOrEqual(20);
    expect(cfg.invitation.limit).toBeLessThanOrEqual(10);
    // Enlace público de confirmación de cita (DX-005): por IP, como invitación.
    expect(cfg.confirmation).toEqual({ limit: 20, ttlMs: 60_000 });
    // DX-048: sin baldes por email en el rate limiter (contaban los aciertos).
    expect(Object.keys(cfg)).not.toContain('login');
    expect(Object.keys(cfg)).not.toContain('login-account');
    // DX-062: la web renueva en cada carga de página y una clínica entera sale
    // por UNA IP; el refresh es un JWT firmado (no se adivina), así que su
    // límite es holgado y va aparte del de login/register.
    expect(cfg.refresh).toEqual({ limit: 120, ttlMs: 60_000 });
    // DX-088: invitar/reenviar, por clínica + usuario.
    expect(cfg['invitation-email']).toEqual({ limit: 10, ttlMs: 60_000 });
    // SEC-046: leer un fichero de importación, por clínica + usuario.
    expect(cfg['patient-import']).toEqual({ limit: 10, ttlMs: 60_000 });
    // DX-099: el cuestionario público de anamnesis, por IP y por token.
    expect(cfg.anamnesis).toEqual({ limit: 20, ttlMs: 60_000 });
    expect(cfg['anamnesis-token']).toEqual({ limit: 10, ttlMs: 60_000 });
  });

  it('SEC-046: lee RATE_LIMIT_PATIENT_IMPORT_LIMIT/_TTL_MS', () => {
    const cfg = loadRateLimitConfig(
      envOf({
        RATE_LIMIT_PATIENT_IMPORT_LIMIT: '3',
        RATE_LIMIT_PATIENT_IMPORT_TTL_MS: '30000',
      }),
    );
    expect(cfg['patient-import']).toEqual({ limit: 3, ttlMs: 30_000 });
  });

  it('DX-099: lee el balde por token de su variable', () => {
    const cfg = loadRateLimitConfig(
      envOf({
        RATE_LIMIT_ANAMNESIS_LIMIT: '5',
        RATE_LIMIT_ANAMNESIS_TOKEN_LIMIT: '3',
        RATE_LIMIT_ANAMNESIS_TOKEN_TTL_MS: '1000',
      }),
    );
    expect(cfg.anamnesis.limit).toBe(5);
    expect(cfg['anamnesis-token']).toEqual({ limit: 3, ttlMs: 1000 });
  });

  it('lee límite y ventana de cada política desde el entorno', () => {
    const cfg = loadRateLimitConfig(
      envOf({
        RATE_LIMIT_GLOBAL_LIMIT: '50',
        RATE_LIMIT_GLOBAL_TTL_MS: '1000',
        RATE_LIMIT_LOGIN_BURST_LIMIT: '3',
        RATE_LIMIT_LOGIN_BURST_TTL_MS: '30000',
        RATE_LIMIT_AUTH_LIMIT: '7',
        RATE_LIMIT_INVITATION_TTL_MS: '120000',
        RATE_LIMIT_PASSWORD_LIMIT: '2',
        RATE_LIMIT_CONFIRMATION_LIMIT: '4',
        RATE_LIMIT_REFRESH_LIMIT: '30',
      }),
    );
    expect(cfg.global).toEqual({ limit: 50, ttlMs: 1000 });
    expect(cfg['login-burst']).toEqual({ limit: 3, ttlMs: 30000 });
    expect(cfg.auth).toEqual({ ...DEFAULT_RATE_LIMITS.auth, limit: 7 });
    expect(cfg.invitation).toEqual({
      ...DEFAULT_RATE_LIMITS.invitation,
      ttlMs: 120000,
    });
    expect(cfg.password.limit).toBe(2);
    expect(cfg.confirmation).toEqual({
      ...DEFAULT_RATE_LIMITS.confirmation,
      limit: 4,
    });
    expect(cfg.refresh).toEqual({ ...DEFAULT_RATE_LIMITS.refresh, limit: 30 });
  });

  it('trata la cadena vacía como "no definida"', () => {
    const cfg = loadRateLimitConfig(
      envOf({ RATE_LIMIT_LOGIN_BURST_LIMIT: '' }),
    );
    expect(cfg['login-burst']).toEqual(DEFAULT_RATE_LIMITS['login-burst']);
  });

  it.each(['0', '-1', 'abc', '1.5', '10req'])(
    'rechaza al arrancar un valor inválido (%s)',
    (value) => {
      expect(() =>
        loadRateLimitConfig(envOf({ RATE_LIMIT_LOGIN_BURST_LIMIT: value })),
      ).toThrow(/RATE_LIMIT_LOGIN_BURST_LIMIT/);
    },
  );
});
