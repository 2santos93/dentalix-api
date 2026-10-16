import {
  BadRequestException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepository,
  type ResetTokenRecord,
} from '../../domain/ports/password-reset-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { passwordPolicyViolation } from '../../../../shared/security/password-policy';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import {
  PasswordResetTokenStatus,
  hashPasswordResetToken,
  isWellFormedPasswordResetToken,
  passwordResetTokenStatus,
} from '../password-reset-token';

export const RESET_TOKEN_MESSAGES: Record<
  Exclude<PasswordResetTokenStatus, 'VALID'>,
  string
> = {
  INVALID:
    'El enlace para restablecer la contraseña no es válido o ya fue reemplazado por uno más reciente. Pide un enlace nuevo.',
  EXPIRED:
    'El enlace para restablecer la contraseña caducó (vale 30 minutos). Pide un enlace nuevo.',
  USED: 'Este enlace para restablecer la contraseña ya se usó. Si necesitas cambiarla otra vez, pide un enlace nuevo.',
};

function tokenError(
  status: Exclude<PasswordResetTokenStatus, 'VALID'>,
): HttpException {
  const message = RESET_TOKEN_MESSAGES[status];
  return status === 'INVALID'
    ? new NotFoundException(message)
    : new GoneException(message);
}

export interface ResetRequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Validar y usar el enlace de restablecimiento (DX-010).
 *
 * Aislamiento: el token es del usuario (tabla global) pero SOLO vale en el
 * host de una clínica donde ese usuario tiene membresía ACTIVA; en cualquier
 * otro host cuenta como inexistente (no revela que el usuario exista allí).
 */
@Injectable()
export class ResetPasswordUseCase {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly repo: PasswordResetRepository,
    private readonly password: PasswordService,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /** Estado del enlace para la pantalla «Restablecer contraseña». */
  async status(input: {
    tenantId: string;
    token: string;
  }): Promise<PasswordResetTokenStatus> {
    const { status } = await this.lookup(input.tenantId, input.token);
    return status;
  }

  async execute(input: {
    tenantId: string;
    token: string;
    password: string;
    meta: ResetRequestMeta;
  }): Promise<void> {
    const violation = passwordPolicyViolation(input.password);
    if (violation) throw new BadRequestException(violation);

    const { status, record } = await this.lookup(input.tenantId, input.token);
    if (status !== 'VALID' || !record) {
      throw tokenError(status === 'VALID' ? 'INVALID' : status);
    }
    const role = await this.repo.activeMembershipRole(
      input.tenantId,
      record.userId,
    );
    if (!role) throw tokenError('INVALID');

    const passwordHash = await this.password.hash(input.password);
    const consumed = await this.repo.consumeAndSetPassword({
      tokenId: record.id,
      userId: record.userId,
      passwordHash,
      now: new Date(),
    });
    if (!consumed) {
      // Otra petición lo usó (o lo reemplazó) entre la lectura y el uso.
      const again = await this.lookup(input.tenantId, input.token);
      throw tokenError(again.status === 'VALID' ? 'USED' : again.status);
    }

    this.logger.log({
      event: 'password_reset.completed',
      tenantId: input.tenantId,
      userId: record.userId,
    });
    await this.audit.record({
      tenantId: input.tenantId,
      locationId: null,
      actor: { kind: 'user', userId: record.userId, role },
      action: 'PASSWORD_RESET',
      resourceType: 'SESSION',
      resourceId: null,
      patient: null,
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      metadata: {},
    });
  }

  private async lookup(
    tenantId: string,
    token: string,
  ): Promise<{
    status: PasswordResetTokenStatus;
    record: ResetTokenRecord | null;
  }> {
    if (!isWellFormedPasswordResetToken(token)) {
      return { status: 'INVALID', record: null };
    }
    const record = await this.repo.findByHash(hashPasswordResetToken(token));
    if (!record) return { status: 'INVALID', record: null };
    // Fuera de una clínica del usuario el enlace "no existe" (ni siquiera se
    // dice si caducó o se usó).
    if (!(await this.repo.activeMembershipRole(tenantId, record.userId))) {
      return { status: 'INVALID', record: null };
    }
    return { status: passwordResetTokenStatus(record, new Date()), record };
  }
}
