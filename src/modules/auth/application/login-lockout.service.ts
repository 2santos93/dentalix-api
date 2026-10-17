import { Inject, Injectable } from '@nestjs/common';
import {
  LOGIN_LOCKOUT_CONFIG,
  LoginLockedError,
  accountBackoffMs,
  accountKeyHash,
  ipKeyHash,
  type LoginLockoutConfig,
} from '../domain/login-lockout';
import {
  LOGIN_THROTTLE_REPOSITORY,
  type LoginThrottleRepository,
} from '../domain/ports/login-throttle-repository.port';

/** IP de una petición sin `req.ip` (no debería pasar con Express). */
const UNKNOWN_IP = 'unknown';

/**
 * Bloqueo del login por fallos (DX-048, SEC-028): ver `login-lockout.ts`.
 *
 * Uso desde el login: `assertCanAttempt` ANTES de mirar la contraseña (en
 * espera se responde 429 sin verificar, así ni un acierto pasa ni se paga
 * argon2), y después `recordFailure` (401) o `recordSuccess`. Las dos ramas
 * del 401 (email inexistente o contraseña mala) escriben lo mismo, así que ni
 * el contador ni el tiempo distinguen si la cuenta existe.
 */
@Injectable()
export class LoginLockoutService {
  constructor(
    @Inject(LOGIN_THROTTLE_REPOSITORY)
    private readonly repo: LoginThrottleRepository,
    @Inject(LOGIN_LOCKOUT_CONFIG) private readonly cfg: LoginLockoutConfig,
  ) {}

  /** Lanza `LoginLockedError` si la cuenta o la IP están en espera. */
  async assertCanAttempt(email: string, ip: string | undefined): Promise<void> {
    const seconds = await this.repo.retryAfterSeconds({
      accountKeyHash: accountKeyHash(email),
      ipKeyHash: ipKeyHash(ip || UNKNOWN_IP),
    });
    if (seconds > 0) throw new LoginLockedError(seconds);
  }

  async recordFailure(email: string, ip: string | undefined): Promise<void> {
    const account = accountKeyHash(email);
    const [failures] = await Promise.all([
      this.repo.recordAccountFailure(account, this.cfg.failureMemoryMs),
      this.repo.recordIpFailure(
        ipKeyHash(ip || UNKNOWN_IP),
        this.cfg.ipFailureLimit,
        this.cfg.ipWindowMs,
      ),
    ]);
    const delayMs = accountBackoffMs(failures, this.cfg);
    if (delayMs > 0) await this.repo.blockAccount(account, delayMs);
  }

  /** Login correcto: la cuenta vuelve a empezar (la IP, no). */
  recordSuccess(email: string): Promise<void> {
    return this.repo.clearAccount(accountKeyHash(email));
  }

  /** Desbloqueo por un ADMIN: borra espera y fallos de la cuenta. */
  unlock(email: string): Promise<void> {
    return this.repo.clearAccount(accountKeyHash(email));
  }

  blockedUntil(email: string): Promise<Date | null> {
    return this.repo.accountBlockedUntil(accountKeyHash(email));
  }
}
