import { Inject, Injectable } from '@nestjs/common';
import {
  LOGIN_LOCKOUT_CONFIG,
  LoginLockedError,
  MFA_ENROLL_CLIENT_BACKOFF,
  MFA_ENROLL_CODE_ATTEMPTS,
  accountKeyHash,
  ipKeyHash,
  mfaEnrollCodeKeyHash,
  mfaEnrollKeyHash,
  mfaKeyHash,
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
 * argon2), y después `recordFailure` (401) o `recordSuccess`. El intento se
 * COBRA a la cuenta en `assertCanAttempt` (atómico en la BD): si se contara
 * al recibir el 401, N intentos simultáneos al acabar una espera probarían N
 * contraseñas antes de que ninguno la renovara. El login correcto borra
 * después el contador. Las dos ramas del 401 (email inexistente o contraseña
 * mala) escriben lo mismo, así que ni el contador ni el tiempo distinguen si
 * la cuenta existe.
 */
@Injectable()
export class LoginLockoutService {
  constructor(
    @Inject(LOGIN_THROTTLE_REPOSITORY)
    private readonly repo: LoginThrottleRepository,
    @Inject(LOGIN_LOCKOUT_CONFIG) private readonly cfg: LoginLockoutConfig,
  ) {}

  /**
   * Lanza `LoginLockedError` si la cuenta o la IP están en espera; si no,
   * cobra el intento a la cuenta (cuenta como fallo hasta `recordSuccess`).
   */
  async assertCanAttempt(email: string, ip: string | undefined): Promise<void> {
    const account = accountKeyHash(email);
    // La IP (y una cuenta ya en espera) se miran primero: un intento
    // rechazado no se cobra a la cuenta.
    const seconds = await this.repo.retryAfterSeconds({
      accountKeyHash: account,
      ipKeyHash: ipKeyHash(ip || UNKNOWN_IP),
    });
    if (seconds > 0) throw new LoginLockedError(seconds);
    const raced = await this.repo.claimAccountAttempt(account, this.cfg);
    if (raced > 0) throw new LoginLockedError(raced);
  }

  /** 401: el fallo de la cuenta ya se cobró; suma el de la IP. */
  async recordFailure(_email: string, ip: string | undefined): Promise<void> {
    await this.repo.recordIpFailure(
      ipKeyHash(ip || UNKNOWN_IP),
      this.cfg.ipFailureLimit,
      this.cfg.ipWindowMs,
    );
  }

  /** Login correcto: la cuenta vuelve a empezar (la IP, no). */
  recordSuccess(email: string): Promise<void> {
    return this.repo.clearAccount(accountKeyHash(email));
  }

  /**
   * SEC-008: cobra un intento de código MFA al superadmin (mismo backoff que
   * la cuenta, contador propio). Lanza `LoginLockedError` si está en espera.
   * Solo lo borra un código correcto (`clearMfa`): ni un login correcto ni el
   * desbloqueo de un ADMIN de clínica.
   */
  async claimMfaAttempt(userId: string): Promise<void> {
    const seconds = await this.repo.claimAccountAttempt(
      mfaKeyHash(userId),
      this.cfg,
    );
    if (seconds > 0) throw new LoginLockedError(seconds);
  }

  /** Código MFA correcto: su contador vuelve a empezar. */
  clearMfa(userId: string): Promise<void> {
    return this.repo.clearAccount(mfaKeyHash(userId));
  }

  /**
   * ¿Este fallo es el que acaba de dejar la cuenta en espera? (DX-021-bis) Solo
   * el primero de la serie: los siguientes renuevan la espera y no se avisan.
   */
  async mfaJustLocked(userId: string): Promise<boolean> {
    const failures = await this.repo.accountFailures(mfaKeyHash(userId));
    return failures === this.cfg.freeFailures;
  }

  /** DX-021-bis: cobra un intento del código del correo, por cuenta e IP. */
  async claimMfaEnrollAttempt(
    userId: string,
    ip: string | null,
  ): Promise<void> {
    const seconds = await this.repo.claimAccountAttempt(
      mfaEnrollKeyHash(userId, ip || UNKNOWN_IP),
      MFA_ENROLL_CLIENT_BACKOFF,
    );
    if (seconds > 0) throw new LoginLockedError(seconds);
  }

  clearMfaEnroll(userId: string, ip: string | null): Promise<void> {
    return this.repo.clearAccount(mfaEnrollKeyHash(userId, ip || UNKNOWN_IP));
  }

  /**
   * Cobra un intento al código de ESE `mfaToken`, sin mirar de dónde viene.
   * `false`: agotado, el código ya no vale aunque sea el correcto. Solo acertar
   * lo borra (el alta lo pide dos veces y confirmar se puede reintentar).
   */
  async claimEnrollCodeAttempt(jti: string): Promise<boolean> {
    const seconds = await this.repo.claimAccountAttempt(
      mfaEnrollCodeKeyHash(jti),
      MFA_ENROLL_CODE_ATTEMPTS,
    );
    return seconds === 0;
  }

  clearEnrollCode(jti: string): Promise<void> {
    return this.repo.clearAccount(mfaEnrollCodeKeyHash(jti));
  }

  /** Desbloqueo por un ADMIN: borra espera y fallos de la cuenta. */
  unlock(email: string): Promise<void> {
    return this.repo.clearAccount(accountKeyHash(email));
  }

  blockedUntil(email: string): Promise<Date | null> {
    return this.repo.accountBlockedUntil(accountKeyHash(email));
  }
}
