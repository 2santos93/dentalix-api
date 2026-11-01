import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  MFA_SECRET_CIPHER,
  MfaSecretCipher,
} from '../../../shared/crypto/mfa-secret-cipher';
import {
  decodeBase32,
  generateTotpSecret,
  matchTotp,
  totpUri,
} from '../../../shared/crypto/totp';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from '../../../shared/crypto/recovery-codes';
import { PasswordService } from '../../../shared/crypto/password.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  BREAK_GLASS_REPOSITORY,
  type BreakGlassRepository,
} from '../domain/ports/break-glass-repository.port';
import {
  USER_MFA_REPOSITORY,
  type UserMfaRepository,
  type UserMfaState,
} from '../domain/ports/user-mfa-repository.port';
import { MFA_MESSAGES, isMfaRequired } from '../domain/user-mfa';
import { userMfaAuditEvent } from '../domain/user-mfa-audit';
import { LoginLockoutService } from './login-lockout.service';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';

/** Mismo emisor que el alta del superadmin (`TOTP_ISSUER` de plataforma). */
export const USER_TOTP_ISSUER = 'Dentalix';

export interface UserMfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
  /** Obligatorio para este usuario en la clínica de la sesión. */
  required: boolean;
}

export interface UserMfaEnrollment {
  secret: string;
  otpauthUri: string;
}

/** Segundo factor que presenta la persona: el código de la app o uno de recuperación. */
export interface SecondFactor {
  code?: string;
  recoveryCode?: string;
}

export type SecondFactorKind = 'TOTP' | 'RECOVERY_CODE';

/** Quién es en la clínica de la sesión (para la política y la auditoría). */
export interface MfaSessionContext extends AuditRequestContext {
  role: ClinicRole;
}

/**
 * DX-021: alta, verificación, códigos de recuperación y baja de la
 * verificación en dos pasos de un usuario. Reutiliza el MFA del superadmin
 * (SEC-008): mismas columnas, mismo cifrado, mismo TOTP con anti-replay
 * (`consumeTotpStep`) y mismo contador de intentos (`claimMfaAttempt`, 5
 * fallos → espera creciente) — el código de la app, el de recuperación y el
 * del alta cuentan en el MISMO contador.
 */
@Injectable()
export class UserMfaService {
  private readonly logger = new Logger('UserMfa');

  constructor(
    @Inject(USER_MFA_REPOSITORY) private readonly repo: UserMfaRepository,
    @Inject(BREAK_GLASS_REPOSITORY)
    private readonly totpSteps: BreakGlassRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: MfaSecretCipher,
    private readonly password: PasswordService,
    private readonly lockout: LoginLockoutService,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /** Política de la clínica: ¿se exige el MFA a sus ADMIN? */
  async clinicPolicy(tenantId: string): Promise<{ requireAdminMfa: boolean }> {
    return {
      requireAdminMfa: (await this.repo.findClinicPolicy(tenantId)) ?? false,
    };
  }

  /**
   * Cambia la política (solo ADMIN, lo exige la ruta). Para ENCENDERLA, quien
   * la enciende debe tener ya su propio MFA activo (si no, el siguiente
   * login le llevaría al alta forzada sin haberlo probado). Auditada con el
   * antes y el después (CLINIC_SETTINGS, `MFA_POLICY`); sin evento si no
   * cambia. Los ADMIN sin MFA pasan por el alta forzada en su próximo login.
   */
  async setClinicPolicy(
    requireAdminMfa: boolean,
    ctx: AuditRequestContext,
  ): Promise<{ requireAdminMfa: boolean }> {
    const before = (await this.repo.findClinicPolicy(ctx.tenantId)) ?? false;
    if (before === requireAdminMfa) return { requireAdminMfa };
    if (requireAdminMfa && !(await this.state(ctx.actor.userId)).enabledAt) {
      throw new ConflictException(MFA_MESSAGES.policyNeedsOwnMfa);
    }
    await this.repo.setClinicPolicy(ctx.tenantId, requireAdminMfa);
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'MFA_POLICY',
        statusChange: {
          from: before ? 'ADMIN_MFA_REQUIRED' : 'ADMIN_MFA_OPTIONAL',
          to: requireAdminMfa ? 'ADMIN_MFA_REQUIRED' : 'ADMIN_MFA_OPTIONAL',
        },
      },
    });
    return { requireAdminMfa };
  }

  async state(userId: string): Promise<UserMfaState> {
    const state = await this.repo.find(userId);
    if (!state) throw new UnauthorizedException('Session is no longer valid');
    return state;
  }

  async isRequired(
    state: Pick<UserMfaState, 'isPlatformAdmin'>,
    tenantId: string,
    role: ClinicRole,
  ): Promise<boolean> {
    const requireAdminMfa =
      (await this.repo.findClinicPolicy(tenantId)) ?? false;
    return isMfaRequired({
      role,
      isPlatformAdmin: state.isPlatformAdmin,
      requireAdminMfa,
    });
  }

  async status(
    userId: string,
    tenantId: string,
    role: ClinicRole,
  ): Promise<UserMfaStatus> {
    const state = await this.state(userId);
    return {
      enabled: state.enabledAt !== null,
      enabledAt: state.enabledAt,
      recoveryCodesRemaining: state.recoveryCodesRemaining,
      required: await this.isRequired(state, tenantId, role),
    };
  }

  /**
   * Paso 1 del alta: secreto nuevo, guardado CIFRADO como pendiente. Desde
   * «Mi perfil» exige la contraseña actual (`currentPassword`): un access
   * token robado no basta para enrolar otro móvil. En el alta forzada del
   * login la contraseña ya se verificó (`null`).
   */
  async startEnrollment(
    userId: string,
    currentPassword: string | null,
    ctx: AuditRequestContext,
  ): Promise<UserMfaEnrollment> {
    const state = await this.state(userId);
    if (currentPassword !== null)
      await this.assertPassword(state, currentPassword);
    if (state.enabledAt)
      throw new ConflictException(MFA_MESSAGES.alreadyEnabled);
    const secret = generateTotpSecret();
    if (
      !(await this.repo.savePending(
        userId,
        this.cipher.encrypt(secret, userId),
      ))
    ) {
      throw new ConflictException(MFA_MESSAGES.alreadyEnabled);
    }
    // Como MFA_ENROLLMENT_STARTED de plataforma (DX-359): el hecho, sin el
    // secreto ni el URI. `record` nunca lanza.
    await this.audit.record(userMfaAuditEvent(ctx, 'MFA_ENROLLMENT_STARTED'));
    return {
      secret,
      otpauthUri: totpUri(secret, state.email, USER_TOTP_ISSUER),
    };
  }

  /**
   * Paso 2 del alta: el código de la app demuestra que el móvil tiene el
   * secreto. Activa, genera 10 códigos de recuperación (se devuelven UNA vez;
   * se guarda su HMAC), cierra las demás sesiones (`tokenVersion` + 1) y
   * audita MFA_ENABLED, todo en una transacción.
   */
  async confirmEnrollment(
    userId: string,
    code: string,
    ctx: AuditRequestContext,
  ): Promise<{
    enabledAt: Date;
    tokenVersion: number;
    recoveryCodes: string[];
  }> {
    const state = await this.state(userId);
    if (state.enabledAt)
      throw new ConflictException(MFA_MESSAGES.alreadyEnabled);
    if (!state.pendingSecretEnc) {
      throw new BadRequestException(MFA_MESSAGES.noPendingEnrollment);
    }
    await this.lockout.claimMfaAttempt(userId);
    const secret = decodeBase32(
      this.cipher.decrypt(state.pendingSecretEnc, userId),
    );
    const step = matchTotp(secret, code, Date.now(), null);
    if (step === null) throw new BadRequestException(MFA_MESSAGES.invalidCode);
    const recoveryCodes = generateRecoveryCodes();
    const enabled = await this.repo.enable(
      userId,
      state.pendingSecretEnc,
      step,
      this.hashCodes(recoveryCodes, userId),
      userMfaAuditEvent(ctx, 'MFA_ENABLED'),
    );
    if (!enabled) throw new ConflictException(MFA_MESSAGES.alreadyEnabled);
    await this.lockout.clearMfa(userId);
    // Solo ids: un alta que su dueño no hizo es una contraseña robada.
    this.logger.warn({
      event: 'user_mfa.enabled',
      userId,
      tenantId: ctx.tenantId,
    });
    return { ...enabled, recoveryCodes };
  }

  /**
   * Comprueba el segundo factor de un usuario con MFA activo. Cobra el
   * intento ANTES de mirar (en espera → `LoginLockedError`, 429) y solo un
   * acierto lo borra. Un código TOTP vale una vez (anti-replay por paso, en
   * una sentencia atómica); uno de recuperación, también. `null` = no vale.
   */
  async verifySecondFactor(
    userId: string,
    state: UserMfaState,
    factor: SecondFactor,
  ): Promise<SecondFactorKind | null> {
    if (!state.enabledAt || !state.secretEnc) return null;
    await this.lockout.claimMfaAttempt(userId);
    let kind: SecondFactorKind | null = null;
    if (factor.code) {
      const secret = decodeBase32(this.cipher.decrypt(state.secretEnc, userId));
      const step = matchTotp(
        secret,
        factor.code,
        Date.now(),
        state.lastUsedStep,
      );
      if (
        step !== null &&
        (await this.totpSteps.consumeTotpStep(userId, step))
      ) {
        kind = 'TOTP';
      }
    } else if (factor.recoveryCode) {
      const canonical = normalizeRecoveryCode(factor.recoveryCode);
      if (
        canonical &&
        (await this.repo.consumeRecoveryCode(
          userId,
          this.cipher.hashRecoveryCode(canonical, userId),
        ))
      ) {
        kind = 'RECOVERY_CODE';
        this.logger.warn({ event: 'user_mfa.recovery_code_used', userId });
      }
    }
    if (kind) await this.lockout.clearMfa(userId);
    return kind;
  }

  /**
   * Baja desde «Mi perfil»: contraseña actual + segundo factor (re-auth). No
   * se puede si es obligatorio (superadmin, o ADMIN de una clínica que lo
   * exige). Cierra las demás sesiones y audita MFA_DISABLED.
   */
  async disable(
    userId: string,
    currentPassword: string,
    factor: SecondFactor,
    ctx: MfaSessionContext,
  ): Promise<number> {
    const state = await this.state(userId);
    await this.assertPassword(state, currentPassword);
    if (!state.enabledAt) throw new ConflictException(MFA_MESSAGES.notEnabled);
    if (state.isPlatformAdmin) {
      throw new ForbiddenException(MFA_MESSAGES.platformAdminCannotDisable);
    }
    if (await this.isRequired(state, ctx.tenantId, ctx.role)) {
      throw new ForbiddenException(MFA_MESSAGES.requiredByClinic);
    }
    await this.assertSecondFactor(userId, state, factor);
    const tv = await this.repo.disable(
      userId,
      userMfaAuditEvent(ctx, 'MFA_DISABLED'),
    );
    if (tv === null) throw new ConflictException(MFA_MESSAGES.notEnabled);
    this.logger.warn({
      event: 'user_mfa.disabled',
      userId,
      tenantId: ctx.tenantId,
    });
    return tv;
  }

  /** Códigos nuevos (los anteriores dejan de valer): contraseña + segundo factor. */
  async regenerateRecoveryCodes(
    userId: string,
    currentPassword: string,
    factor: SecondFactor,
    ctx: AuditRequestContext,
  ): Promise<string[]> {
    const state = await this.state(userId);
    await this.assertPassword(state, currentPassword);
    if (!state.enabledAt) throw new ConflictException(MFA_MESSAGES.notEnabled);
    await this.assertSecondFactor(userId, state, factor);
    const codes = generateRecoveryCodes();
    const ok = await this.repo.replaceRecoveryCodes(
      userId,
      this.hashCodes(codes, userId),
      userMfaAuditEvent(ctx, 'MFA_RECOVERY_CODES_REGENERATED'),
    );
    if (!ok) throw new ConflictException(MFA_MESSAGES.notEnabled);
    return codes;
  }

  private async assertSecondFactor(
    userId: string,
    state: UserMfaState,
    factor: SecondFactor,
  ): Promise<void> {
    if (!(await this.verifySecondFactor(userId, state, factor))) {
      throw new BadRequestException(
        factor.recoveryCode
          ? MFA_MESSAGES.invalidRecoveryCode
          : MFA_MESSAGES.invalidCode,
      );
    }
  }

  /** 400 (no 401): la web reintenta los 401 con un refresh y contaría dos intentos. */
  private async assertPassword(
    state: UserMfaState,
    plain: string,
  ): Promise<void> {
    if (!(await this.password.verify(plain, state.passwordHash))) {
      throw new BadRequestException(MFA_MESSAGES.wrongPassword);
    }
  }

  private hashCodes(codes: string[], userId: string): string[] {
    return codes.map((code) =>
      this.cipher.hashRecoveryCode(normalizeRecoveryCode(code)!, userId),
    );
  }
}
