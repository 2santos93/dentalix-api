import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
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
import {
  PLATFORM_MFA_REPOSITORY,
  type PlatformMfaRepository,
} from '../../domain/ports/platform-mfa-repository.port';

export const TOTP_ISSUER = 'Dentalix';

export interface PlatformMfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
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
  constructor(
    @Inject(PLATFORM_MFA_REPOSITORY)
    private readonly repo: PlatformMfaRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: MfaSecretCipher,
  ) {}

  async status(userId: string): Promise<PlatformMfaStatus> {
    const state = await this.require(userId);
    return { enabled: state.enabledAt !== null, enabledAt: state.enabledAt };
  }

  async start(userId: string): Promise<PlatformMfaEnrollment> {
    const state = await this.require(userId);
    if (state.enabledAt) throw alreadyEnabled();
    const secret = generateTotpSecret();
    if (
      !(await this.repo.savePending(
        userId,
        this.cipher.encrypt(secret, userId),
      ))
    ) {
      throw alreadyEnabled();
    }
    return { secret, otpauthUri: totpUri(secret, state.email, TOTP_ISSUER) };
  }

  async confirm(userId: string, code: string): Promise<PlatformMfaStatus> {
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
    );
    if (!enabledAt) throw alreadyEnabled();
    return { enabled: true, enabledAt };
  }

  private async require(userId: string) {
    const state = await this.repo.find(userId);
    if (!state) throw new ForbiddenException('Platform admin only');
    return state;
  }
}

function alreadyEnabled(): ConflictException {
  return new ConflictException(
    'La verificación en dos pasos ya está activa en esta cuenta.',
  );
}
