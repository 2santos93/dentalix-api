import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepository,
} from '../../domain/ports/password-reset-repository.port';
import {
  PASSWORD_RESET_NOTIFIER,
  type PasswordResetNotifier,
} from '../../domain/ports/password-reset-notifier.port';
import {
  PASSWORD_RESET_PATH,
  PASSWORD_RESET_TTL_MINUTES,
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetExpiresAt,
} from '../password-reset-token';
import { PasswordResetThrottledError } from '../../domain/password-reset-throttled.error';
import {
  DEFAULT_PASSWORD_RESET_LIMITS,
  PASSWORD_RESET_CLOCK,
  PASSWORD_RESET_LIMITS,
  type PasswordResetLimits,
} from '../password-reset-limits';
import { ResetTurns, type TurnRefusal } from '../reset-turns';

export interface RequestPasswordResetInput {
  /** Clínica del HOST de la petición (la resuelve el servidor). */
  tenantId: string;
  email: string;
  /** `<protocolo>://<host de PLATAFORMA de la clínica>` (SEC-033: TenantLinkBaseService). */
  linkBase: string;
}

/** Como mucho una línea `password_reset.dropped` cada esto (ms). */
export const PASSWORD_RESET_DROP_LOG_INTERVAL_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Qué pasó, solo para el log y los tests: NUNCA llega a la respuesta. */
export type RequestPasswordResetOutcome = 'SENT' | 'NO_MEMBER' | 'THROTTLED';

/**
 * «¿Olvidaste tu contraseña?» (DX-010). Sin enumeración de usuarios: el
 * controlador responde siempre 202 con el mismo cuerpo y deja el trabajo en
 * segundo plano (`accept`), así que ni el cuerpo ni el tiempo de respuesta
 * dependen de si el email existe, está activo en la clínica o pasó los topes.
 *
 * Solo se envía a un MIEMBRO ACTIVO de la clínica del host: el email lleva su
 * marca y el enlace a su host. Pedir otro invalida los anteriores. Nada cambia
 * en la cuenta (ni contraseña ni bloqueo) hasta que llega un token válido.
 *
 * DX-149-ter: el token y su email se emiten en UNA transacción con el tope
 * del destinatario contado bajo su candado (y un `lock_timeout` corto). Una
 * ráfaga a la misma persona, aunque venga de muchas IP, no pasa del tope ni
 * deja el enlace del email que salió sin valor.
 *
 * DX-149-quater: además, un tope POR USUARIO sumando todas sus clínicas
 * (contado en la misma transacción, bajo el bloqueo de su fila), y como mucho
 * `concurrency` en curso a la vez en el proceso: el resto espera turno en
 * orden de llegada, en una cola acotada (`maxQueue`, `queueMaxWaitMs`); lo
 * que no cabe o caduca se descarta en silencio. La respuesta pública ya salió
 * y no depende de nada de esto (ver `PasswordResetLimits`).
 */
@Injectable()
export class RequestPasswordResetUseCase {
  private readonly logger = new Logger('Auth');
  private readonly limits: PasswordResetLimits;
  private readonly turns: ResetTurns;
  private readonly clock: () => number;
  /** Descartes aún sin contar en el log (ver `noteDrop`). */
  private readonly dropped: Record<TurnRefusal, number> = {
    QUEUE_FULL: 0,
    QUEUE_EXPIRED: 0,
  };
  private lastDropLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly repo: PasswordResetRepository,
    @Inject(PASSWORD_RESET_NOTIFIER)
    private readonly notifier: PasswordResetNotifier,
    @Optional()
    @Inject(PASSWORD_RESET_LIMITS)
    limits?: Partial<PasswordResetLimits>,
    @Optional()
    @Inject(PASSWORD_RESET_CLOCK)
    clock?: () => number,
  ) {
    this.limits = { ...DEFAULT_PASSWORD_RESET_LIMITS, ...limits };
    this.clock = clock ?? Date.now;
    this.turns = new ResetTurns(
      this.limits.concurrency,
      this.limits.maxQueue,
      this.limits.queueMaxWaitMs,
      this.clock,
    );
  }

  /** Lanza el trabajo sin esperarlo. Nunca lanza ni rechaza. */
  accept(input: RequestPasswordResetInput): void {
    this.execute(input).catch((err: unknown) => {
      // Solo el tipo de error: el mensaje de Prisma puede llevar el email.
      this.logger.warn({
        event: 'password_reset.request_failed',
        tenantId: input.tenantId,
        error: err instanceof Error ? err.constructor.name : typeof err,
      });
    });
  }

  /**
   * Espera turno (DX-149-quater) y hace el trabajo. Todas sus transacciones
   * corren con el turno tomado, una detrás de otra. Sin turno (cola llena o
   * caducada): THROTTLED sin tocar la BD.
   */
  async execute(
    input: RequestPasswordResetInput,
  ): Promise<RequestPasswordResetOutcome> {
    const refusal = await this.turns.acquire();
    if (refusal) {
      this.noteDrop(refusal);
      return 'THROTTLED';
    }
    try {
      return await this.run(input);
    } finally {
      this.turns.release();
    }
  }

  private async run(
    input: RequestPasswordResetInput,
  ): Promise<RequestPasswordResetOutcome> {
    const email = input.email.trim().toLowerCase();
    const member = await this.repo.findActiveMember(input.tenantId, email);
    if (!member) {
      return this.done(input.tenantId, 'NO_MEMBER');
    }
    if (!(await this.notifier.withinQuota(input.tenantId, member.email))) {
      return this.done(input.tenantId, 'THROTTLED');
    }
    const now = new Date();
    // DX-149-quater: aviso temprano del tope por usuario, sin candado (como
    // `withinQuota`): ahorra renderizar y cifrar cuando ya no cabe. El que
    // manda es el de `issue`, bajo el bloqueo de su fila.
    const issuedToday = await this.repo.countIssuedSince(
      member.userId,
      new Date(now.getTime() - DAY_MS),
    );
    if (issuedToday >= this.limits.userDailyLimit) {
      return this.done(input.tenantId, 'THROTTLED', 'USER_QUOTA');
    }
    const token = generatePasswordResetToken();
    // Renderizar y cifrar (y leer la marca de la clínica) ANTES de abrir la
    // transacción: dentro no se pide otra conexión.
    const mail = await this.notifier.prepare({
      tenantId: input.tenantId,
      userId: member.userId,
      to: member.email,
      userName: member.fullName,
      resetUrl: `${input.linkBase}${PASSWORD_RESET_PATH}/${token}`,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
    try {
      // DX-149-ter: token y email en UNA transacción, con el tope del
      // destinatario contado bajo su candado. Si no cabe (otra petición ganó
      // la carrera) o el candado no se libera a tiempo, no cambia nada: el
      // enlace vigente sigue siendo el anterior. DX-149-quater: también el
      // tope por usuario de todas sus clínicas.
      await this.repo.issue({
        tenantId: input.tenantId,
        userId: member.userId,
        tokenHash: hashPasswordResetToken(token),
        expiresAt: passwordResetExpiresAt(now),
        now,
        userDailyLimit: this.limits.userDailyLimit,
        enqueue: (tx) => mail.insert(tx),
      });
    } catch (err) {
      if (err instanceof PasswordResetThrottledError) {
        return this.done(input.tenantId, 'THROTTLED', err.reason);
      }
      throw err;
    }
    mail.kick();
    return this.done(input.tenantId, 'SENT');
  }

  /**
   * Un descarte por cola (DX-149-quater). Sin una línea por petición (quien
   * inunda decidiría el volumen del log): como mucho una cada
   * `PASSWORD_RESET_DROP_LOG_INTERVAL_MS`, con los recuentos acumulados y
   * nada de la petición (ni email ni clínica).
   */
  private noteDrop(refusal: TurnRefusal): void {
    this.dropped[refusal]++;
    const now = this.clock();
    if (now - this.lastDropLogAt < PASSWORD_RESET_DROP_LOG_INTERVAL_MS) return;
    this.lastDropLogAt = now;
    this.logger.warn({
      event: 'password_reset.dropped',
      queueFull: this.dropped.QUEUE_FULL,
      queueExpired: this.dropped.QUEUE_EXPIRED,
      queued: this.turns.waiting,
      concurrency: this.limits.concurrency,
    });
    this.dropped.QUEUE_FULL = 0;
    this.dropped.QUEUE_EXPIRED = 0;
  }

  // Sin email ni token: el resultado y la clínica bastan para operar.
  private done(
    tenantId: string,
    outcome: RequestPasswordResetOutcome,
    reason?: PasswordResetThrottledError['reason'],
  ): RequestPasswordResetOutcome {
    this.logger.log({
      event: 'password_reset.requested',
      tenantId,
      outcome,
      ...(reason ? { reason } : {}),
    });
    return outcome;
  }
}
