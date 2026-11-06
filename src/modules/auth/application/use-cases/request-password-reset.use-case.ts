import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Semaphore } from '../../../../shared/prisma/transaction-budget';
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

export interface RequestPasswordResetInput {
  /** Clínica del HOST de la petición (la resuelve el servidor). */
  tenantId: string;
  email: string;
  /** `<protocolo>://<host de PLATAFORMA de la clínica>` (SEC-033: TenantLinkBaseService). */
  linkBase: string;
}

/**
 * DX-149-quater: cuántos restablecimientos pueden tener su trabajo en curso
 * (y, con él, su transacción abierta) a la vez en un proceso
 * (`PASSWORD_RESET_MAX_CONCURRENCY`). El endpoint es público y responde 202
 * sin esperar: sin este límite, una inundación desde muchas IP (el rate limit
 * es por IP) abre tantas transacciones como peticiones y agota el pool de las
 * clínicas. 4 de las conexiones del pool como mucho; cada una dura unos ms
 * (`PASSWORD_RESET_LOCK_TIMEOUT_MS` como techo), así que el turno llega rápido.
 */
export const DEFAULT_PASSWORD_RESET_CONCURRENCY = 4;
export const PASSWORD_RESET_CONCURRENCY = Symbol('PASSWORD_RESET_CONCURRENCY');

/**
 * `PASSWORD_RESET_MAX_CONCURRENCY` (ya validado por `validateEnv`: entero
 * 1..100), o el default si viene vacío.
 */
export function passwordResetConcurrency(raw: string | undefined): number {
  const value = raw?.trim();
  return value ? Number(value) : DEFAULT_PASSWORD_RESET_CONCURRENCY;
}

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
 * `PASSWORD_RESET_CONCURRENCY` en curso a la vez en el proceso: el resto
 * espera turno en orden de llegada (la respuesta pública ya salió).
 */
@Injectable()
export class RequestPasswordResetUseCase {
  private readonly logger = new Logger('Auth');
  private readonly turns: Semaphore;

  constructor(
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly repo: PasswordResetRepository,
    @Inject(PASSWORD_RESET_NOTIFIER)
    private readonly notifier: PasswordResetNotifier,
    @Optional()
    @Inject(PASSWORD_RESET_CONCURRENCY)
    concurrency?: number,
  ) {
    this.turns = new Semaphore(
      concurrency ?? DEFAULT_PASSWORD_RESET_CONCURRENCY,
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
   * corren con el turno tomado, una detrás de otra.
   */
  async execute(
    input: RequestPasswordResetInput,
  ): Promise<RequestPasswordResetOutcome> {
    await this.turns.acquire();
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
    const token = generatePasswordResetToken();
    const now = new Date();
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
        userDailyLimit: this.notifier.userDailyLimit(),
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
