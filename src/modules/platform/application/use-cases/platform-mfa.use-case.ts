import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { breakGlassMfaCooldownMinutes } from '../../../auth/domain/break-glass';
import {
  UserMfaService,
  type SecondFactor,
} from '../../../auth/application/user-mfa.service';
import type { PlatformAuditActor } from '../../../audit/domain/platform-audit-event';
import {
  PLATFORM_MFA_REPOSITORY,
  type PlatformMfaRepository,
} from '../../domain/ports/platform-mfa-repository.port';

export interface PlatformMfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  /**
   * Desde cuándo sirve para el break-glass: `enabledAt` + la espera de
   * seguridad (BREAK_GLASS_MFA_COOLDOWN_MINUTES). `null` sin MFA.
   */
  breakGlassAvailableAt: Date | null;
  /** Quien lo activó antes de DX-021-bis no tiene ninguno hasta generarlos. */
  recoveryCodesRemaining: number;
}

/**
 * SEC-008: MFA (TOTP) del superadmin desde su sesión de PLATAFORMA. DX-021-bis:
 * el alta ya no se hace aquí sino en el login del apex (sin sesión de
 * plataforma sin MFA no hay nada que enrolar); aquí se consulta y se renuevan
 * los códigos de recuperación. Para rotar el secreto:
 * docs/runbooks/platform-mfa.md.
 */
@Injectable()
export class PlatformMfaUseCase {
  private readonly cooldownMs: number;

  constructor(
    @Inject(PLATFORM_MFA_REPOSITORY)
    private readonly repo: PlatformMfaRepository,
    private readonly mfa: UserMfaService,
    config: ConfigService,
  ) {
    this.cooldownMs =
      breakGlassMfaCooldownMinutes(
        config.get<string>('BREAK_GLASS_MFA_COOLDOWN_MINUTES'),
      ) * 60_000;
  }

  async status(userId: string): Promise<PlatformMfaStatus> {
    const state = await this.repo.find(userId);
    if (!state) throw new ForbiddenException('Platform admin only');
    const { enabledAt, recoveryCodesRemaining } = state;
    return {
      enabled: enabledAt !== null,
      enabledAt,
      breakGlassAvailableAt: enabledAt
        ? new Date(enabledAt.getTime() + this.cooldownMs)
        : null,
      recoveryCodesRemaining: enabledAt ? recoveryCodesRemaining : 0,
    };
  }

  /** Códigos nuevos (los anteriores dejan de valer): contraseña + segundo factor. */
  regenerateRecoveryCodes(
    actor: PlatformAuditActor,
    currentPassword: string,
    factor: SecondFactor,
  ): Promise<string[]> {
    return this.mfa.regenerateRecoveryCodes(
      actor.userId,
      currentPassword,
      factor,
      actor,
    );
  }
}
