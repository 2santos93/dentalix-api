import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { breakGlassMfaCooldownMinutes } from '../../../auth/domain/break-glass';
import {
  MFA_SECRET_CIPHER,
  MfaSecretCipher,
} from '../../../../shared/crypto/mfa-secret-cipher';
import {
  decodeBase32,
  generateTotpSecret,
  matchTotp,
  totpUri,
} from '../../../../shared/crypto/totp';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import {
  PLATFORM_MFA_REPOSITORY,
  type PlatformMfaRepository,
} from '../../domain/ports/platform-mfa-repository.port';

export const TOTP_ISSUER = 'Dentalix';

export interface PlatformMfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  /**
   * Desde cuándo sirve para el break-glass: `enabledAt` + la espera de
   * seguridad (BREAK_GLASS_MFA_COOLDOWN_MINUTES). `null` sin MFA.
   */
  breakGlassAvailableAt: Date | null;
}

export interface PlatformMfaEnrollment {
  /** Secreto en base32 para teclearlo en la app (se muestra UNA vez). */
  secret: string;
  /** `otpauth://totp/...` para el QR o para abrir la app. */
  otpauthUri: string;
}

/**
 * SEC-008: alta del MFA (TOTP) del superadmin desde su sesión de PLATAFORMA.
 * Dos pasos: `start` genera un secreto y lo guarda cifrado como pendiente;
 * `confirm` lo activa solo si el superadmin demuestra que su app genera el
 * código correcto. Con el MFA activo no se puede volver a enrolar (409): un
 * atacante con la contraseña no puede sustituir el secreto. Para rotarlo hace
 * falta una intervención manual en la BD (fuera de alcance).
 */
@Injectable()
export class PlatformMfaUseCase {
  private readonly logger = new Logger('PlatformMfa');
  private readonly cooldownMs: number;

  constructor(
    @Inject(PLATFORM_MFA_REPOSITORY)
    private readonly repo: PlatformMfaRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: MfaSecretCipher,
    config: ConfigService,
  ) {
    this.cooldownMs =
      breakGlassMfaCooldownMinutes(
        config.get<string>('BREAK_GLASS_MFA_COOLDOWN_MINUTES'),
      ) * 60_000;
  }

  async status(userId: string): Promise<PlatformMfaStatus> {
    const state = await this.require(userId);
    return this.statusOf(state.enabledAt);
  }

  private statusOf(enabledAt: Date | null): PlatformMfaStatus {
    return {
      enabled: enabledAt !== null,
      enabledAt,
      breakGlassAvailableAt: enabledAt
        ? new Date(enabledAt.getTime() + this.cooldownMs)
        : null,
    };
  }

  /**
   * DX-359: `request` es desde dónde lo pide el superadmin; el alta queda en
   * `platform_audit_events` (sin el secreto) en la transacción que la guarda.
   */
  async start(
    userId: string,
    request: AuditRequestMeta,
  ): Promise<PlatformMfaEnrollment> {
    const state = await this.require(userId);
    if (state.enabledAt) throw alreadyEnabled();
    const secret = generateTotpSecret();
    if (
      !(await this.repo.savePending(
        userId,
        this.cipher.encrypt(secret, userId),
        { userId, ...request },
      ))
    ) {
      throw alreadyEnabled();
    }
    return { secret, otpauthUri: totpUri(secret, state.email, TOTP_ISSUER) };
  }

  /** DX-359: la activación queda en `platform_audit_events` (sin el código). */
  async confirm(
    userId: string,
    code: string,
    request: AuditRequestMeta,
  ): Promise<PlatformMfaStatus> {
    const state = await this.require(userId);
    if (state.enabledAt) throw alreadyEnabled();
    if (!state.pendingSecretEnc) {
      throw new BadRequestException(
        'Primero inicia la activación de la verificación en dos pasos.',
      );
    }
    const secret = decodeBase32(
      this.cipher.decrypt(state.pendingSecretEnc, userId),
    );
    const step = matchTotp(secret, code, Date.now(), null);
    if (step === null) {
      throw new BadRequestException(
        'El código no es correcto. Revisa la hora del móvil y usa el código vigente de la app.',
      );
    }
    const enabledAt = await this.repo.confirm(
      userId,
      state.pendingSecretEnc,
      step,
      { userId, ...request },
    );
    if (!enabledAt) throw alreadyEnabled();
    // SEC-008: evento para alertas de seguridad. Un alta que su dueño no hizo
    // es una contraseña robada; el break-glass sigue cerrado durante la
    // espera de seguridad (BREAK_GLASS_MFA_COOLDOWN_MINUTES).
    this.logger.warn({ event: 'platform_mfa.enabled', userId });
    return this.statusOf(enabledAt);
  }

  private async require(userId: string) {
    const state = await this.repo.find(userId);
    if (!state) throw new ForbiddenException('Platform admin only');
    return state;
  }
}

function alreadyEnabled(): ConflictException {
  return new ConflictException(
    'La verificación en dos pasos ya está activa en esta cuenta. Si no la activaste tú, cambia tu contraseña y avisa al equipo de seguridad de Dentalix.',
  );
}
