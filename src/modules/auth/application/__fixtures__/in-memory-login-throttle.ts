import { accountBackoffMs } from '../../domain/login-lockout';
import type {
  AccountBackoffPolicy,
  LoginThrottleKeys,
  LoginThrottleRepository,
} from '../../domain/ports/login-throttle-repository.port';

interface Row {
  failures: number;
  windowStartedAt: number;
  lastFailureAt: number;
  blockedUntil: number | null;
}

/** Repositorio en memoria con la semántica del de Prisma y un reloj propio. */
export class InMemoryLoginThrottleRepository implements LoginThrottleRepository {
  private now = Date.UTC(2026, 9, 16, 9, 0, 0);
  private readonly rows = new Map<string, Row>();

  advance(ms: number): void {
    this.now += ms;
  }

  size(): number {
    return this.rows.size;
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }

  private remaining(key: string): number {
    const until = this.rows.get(key)?.blockedUntil ?? null;
    return until !== null && until > this.now
      ? Math.ceil((until - this.now) / 1000)
      : 0;
  }

  retryAfterSeconds(keys: LoginThrottleKeys): Promise<number> {
    return Promise.resolve(
      Math.max(
        this.remaining(`ACCOUNT:${keys.accountKeyHash}`),
        this.remaining(`IP:${keys.ipKeyHash}`),
      ),
    );
  }

  claimAccountAttempt(
    key: string,
    policy: AccountBackoffPolicy,
  ): Promise<number> {
    const id = `ACCOUNT:${key}`;
    const blocked = this.remaining(id);
    if (blocked > 0) return Promise.resolve(blocked);
    const row = this.rows.get(id);
    const fresh =
      !row || row.lastFailureAt <= this.now - policy.failureMemoryMs;
    const failures = fresh ? 1 : row.failures + 1;
    const delay = accountBackoffMs(failures, policy);
    const previous = fresh ? null : row.blockedUntil;
    this.rows.set(id, {
      failures,
      windowStartedAt: fresh ? this.now : row.windowStartedAt,
      lastFailureAt: this.now,
      blockedUntil:
        delay > 0 ? Math.max(previous ?? 0, this.now + delay) : previous,
    });
    return Promise.resolve(0);
  }

  recordIpFailure(key: string, limit: number, windowMs: number): Promise<void> {
    const id = `IP:${key}`;
    const row = this.rows.get(id);
    const fresh = !row || row.windowStartedAt <= this.now - windowMs;
    const failures = fresh ? 1 : row.failures + 1;
    const windowStartedAt = fresh ? this.now : row.windowStartedAt;
    this.rows.set(id, {
      failures,
      windowStartedAt,
      lastFailureAt: this.now,
      blockedUntil: failures >= limit ? windowStartedAt + windowMs : null,
    });
    return Promise.resolve();
  }

  clearAccount(key: string): Promise<void> {
    // Map en memoria del fixture, no un modelo de Prisma.
    // eslint-disable-next-line no-restricted-syntax
    this.rows.delete(`ACCOUNT:${key}`);
    return Promise.resolve();
  }

  accountBlockedUntil(key: string): Promise<Date | null> {
    const until = this.rows.get(`ACCOUNT:${key}`)?.blockedUntil ?? null;
    return Promise.resolve(
      until !== null && until > this.now ? new Date(until) : null,
    );
  }
}
