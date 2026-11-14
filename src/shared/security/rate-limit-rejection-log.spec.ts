import {
  REJECTION_LOG_INTERVAL_MS,
  RateLimitRejectionLog,
} from './rate-limit-rejection-log';

describe('RateLimitRejectionLog (DX-555)', () => {
  let now: number;
  let lines: Record<string, unknown>[];
  let log: RateLimitRejectionLog;

  beforeEach(() => {
    now = 1_000_000;
    lines = [];
    log = new RateLimitRejectionLog(
      'GET /api/v1/public/tenant/branding/by-host',
      { warn: (m: unknown) => lines.push(m as Record<string, unknown>) },
      () => now,
    );
  });

  it('el primer 429 sale al momento, con la ruta y la política', () => {
    log.record('branding-miss', 42);
    expect(lines).toEqual([
      {
        event: 'rate_limit.rejected',
        route: 'GET /api/v1/public/tenant/branding/by-host',
        policy: 'branding-miss',
        rejected: 1,
        retryAfterSeconds: 42,
      },
    ]);
  });

  it('un aluvión da una línea por intervalo con el recuento acumulado', () => {
    for (let i = 0; i < 1000; i++) log.record('branding-miss', 30);
    expect(lines).toHaveLength(1);
    now += REJECTION_LOG_INTERVAL_MS;
    log.record('branding-miss', 20);
    expect(lines).toHaveLength(2);
    // Los 999 que se callaron + el que abre la nueva línea.
    expect(lines[1]).toEqual(expect.objectContaining({ rejected: 1000 }));
  });

  it('cada política lleva su propio intervalo', () => {
    log.record('branding-miss', 10);
    log.record('branding-host', 10);
    expect(lines.map((l) => l.policy)).toEqual([
      'branding-miss',
      'branding-host',
    ]);
  });
});
