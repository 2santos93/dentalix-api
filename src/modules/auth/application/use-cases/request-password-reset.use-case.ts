import { Inject, Injectable, Logger } from '@nestjs/common';
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

export interface RequestPasswordResetInput {
  /** Clínica del HOST de la petición (la resuelve el servidor). */
  tenantId: string;
  email: string;
  /** `<protocolo>://<host de la clínica>` validado (safeLinkHost). */
  linkBase: string;
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
 */
@Injectable()
export class RequestPasswordResetUseCase {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly repo: PasswordResetRepository,
    @Inject(PASSWORD_RESET_NOTIFIER)
    private readonly notifier: PasswordResetNotifier,
  ) {}

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

  async execute(
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
    await this.repo.issue({
      userId: member.userId,
      tokenHash: hashPasswordResetToken(token),
      expiresAt: passwordResetExpiresAt(now),
      now,
    });
    await this.notifier.send({
      tenantId: input.tenantId,
      userId: member.userId,
      to: member.email,
      userName: member.fullName,
      resetUrl: `${input.linkBase}${PASSWORD_RESET_PATH}/${token}`,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
    return this.done(input.tenantId, 'SENT');
  }

  // Sin email ni token: el resultado y la clínica bastan para operar.
  private done(
    tenantId: string,
    outcome: RequestPasswordResetOutcome,
  ): RequestPasswordResetOutcome {
    this.logger.log({ event: 'password_reset.requested', tenantId, outcome });
    return outcome;
  }
}
