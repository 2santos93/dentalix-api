import {
  DEFAULT_LOGIN_LOCKOUT,
  accountBackoffMs,
  accountKeyHash,
  ipKeyHash,
  loadLoginLockoutConfig,
  loginLockedMessage,
} from './login-lockout';

const MIN = 60_000;
const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('accountBackoffMs (DX-048)', () => {
  const cfg = DEFAULT_LOGIN_LOCKOUT;

  it.each([0, 1, 2, 3, 4])(
    'sin espera con %i fallos (por debajo de 5)',
    (n) => {
      expect(accountBackoffMs(n, cfg)).toBe(0);
    },
  );

  it.each([
    [5, 1 * MIN],
    [6, 2 * MIN],
    [7, 4 * MIN],
    [8, 8 * MIN],
    [9, 15 * MIN],
    [10, 15 * MIN],
    [50, 15 * MIN],
  ])('con %i fallos espera %i ms (1, 2, 4, 8… min, tope 15)', (n, ms) => {
    expect(accountBackoffMs(n, cfg)).toBe(ms);
  });

  it('nunca pasa del tope ni con contadores enormes (sin Infinity ni NaN)', () => {
    expect(accountBackoffMs(10_000, cfg)).toBe(cfg.maxDelayMs);
    expect(accountBackoffMs(Number.MAX_SAFE_INTEGER, cfg)).toBe(cfg.maxDelayMs);
  });

  it('respeta una política propia', () => {
    const custom = {
      ...cfg,
      freeFailures: 2,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
    };
    expect(accountBackoffMs(1, custom)).toBe(0);
    expect(accountBackoffMs(2, custom)).toBe(1000);
    expect(accountBackoffMs(3, custom)).toBe(2000);
    expect(accountBackoffMs(4, custom)).toBe(3000);
  });
});

describe('claves del contador', () => {
  it('la cuenta se indexa por el hash del email NORMALIZADO, nunca en claro', () => {
    const key = accountKeyHash('  Doctora@Sonrisa.COM ');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(accountKeyHash('doctora@sonrisa.com'));
    expect(key).not.toContain('doctora');
  });

  it('IP y cuenta tienen espacios de claves distintos', () => {
    expect(ipKeyHash('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    expect(ipKeyHash('x')).not.toBe(accountKeyHash('x'));
    expect(ipKeyHash('203.0.113.7')).not.toBe(ipKeyHash('203.0.113.8'));
  });
});

describe('loginLockedMessage', () => {
  it.each([
    [1, 1],
    [59, 1],
    [60, 1],
    [61, 2],
    [120, 2],
    [900, 15],
  ])('%i s de espera → «en %i min»', (seconds, minutes) => {
    expect(loginLockedMessage(seconds)).toBe(
      `Demasiados intentos. Vuelve a intentarlo en ${minutes} min.`,
    );
  });
});

describe('loadLoginLockoutConfig', () => {
  it('defaults seguros: 5 fallos sin espera, 1 min a 15 min, olvido en 1 h, 100 fallos/15 min por IP', () => {
    const cfg = loadLoginLockoutConfig(envOf({}));
    expect(cfg).toEqual(DEFAULT_LOGIN_LOCKOUT);
    expect(cfg).toEqual({
      freeFailures: 5,
      baseDelayMs: MIN,
      maxDelayMs: 15 * MIN,
      failureMemoryMs: 60 * MIN,
      ipFailureLimit: 100,
      ipWindowMs: 15 * MIN,
    });
  });

  it('lee cada valor del entorno', () => {
    expect(
      loadLoginLockoutConfig(
        envOf({
          LOGIN_LOCKOUT_FREE_FAILURES: '3',
          LOGIN_LOCKOUT_BASE_DELAY_MS: '1000',
          LOGIN_LOCKOUT_MAX_DELAY_MS: '8000',
          LOGIN_LOCKOUT_RESET_MS: '60000',
          LOGIN_IP_FAILURE_LIMIT: '7',
          LOGIN_IP_FAILURE_WINDOW_MS: '30000',
        }),
      ),
    ).toEqual({
      freeFailures: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      failureMemoryMs: 60000,
      ipFailureLimit: 7,
      ipWindowMs: 30000,
    });
  });

  it.each(['0', '-1', 'abc', '1.5'])(
    'rechaza un valor no entero positivo (%s)',
    (raw) => {
      expect(() =>
        loadLoginLockoutConfig(envOf({ LOGIN_LOCKOUT_FREE_FAILURES: raw })),
      ).toThrow(/LOGIN_LOCKOUT_FREE_FAILURES/);
    },
  );

  it('rechaza un tope menor que la espera inicial', () => {
    expect(() =>
      loadLoginLockoutConfig(
        envOf({
          LOGIN_LOCKOUT_BASE_DELAY_MS: '10000',
          LOGIN_LOCKOUT_MAX_DELAY_MS: '5000',
        }),
      ),
    ).toThrow(/LOGIN_LOCKOUT_MAX_DELAY_MS/);
  });

  it('rechaza olvidar los fallos antes de que acabe la espera máxima', () => {
    expect(() =>
      loadLoginLockoutConfig(
        envOf({
          LOGIN_LOCKOUT_MAX_DELAY_MS: '900000',
          LOGIN_LOCKOUT_RESET_MS: '600000',
        }),
      ),
    ).toThrow(/LOGIN_LOCKOUT_RESET_MS/);
  });
});
