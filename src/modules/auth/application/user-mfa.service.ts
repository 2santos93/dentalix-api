import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
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
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';
import {
  BREAK_GLASS_REPOSITORY,
  type BreakGlassRepository,
} from '../domain/ports/break-glass-repository.port';
import {
  USER_MFA_REPOSITORY,
  type TrustedDevice,
  type UserMfaRepository,
  type UserMfaState,
} from '../domain/ports/user-mfa-repository.port';
import {
  MFA_NOTIFIER,
  type MfaNotifier,
} from '../domain/ports/mfa-notifier.port';
import {
  MFA_MESSAGES,
  MFA_TRUSTED_DEVICE_DAYS,
  isMfaRequired,
  trustedDeviceLabel,
  type ClinicMfaPolicy,
  type MfaResetReason,
} from '../domain/user-mfa';
import {
  mfaAuditEvent,
  mfaResetAuditEvent,
  userMfaAuditEvent,
  type MfaActorContext,
  type MfaAuditDraft,
} from '../domain/user-mfa-audit';
import { LoginLockoutService } from './login-lockout.service';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';

const NO_POLICY: ClinicMfaPolicy = {
  requireAdminMfa: false,
  requireAllMfa: false,
};

const hashDeviceToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Quién queda obligado con `after` y no lo estaba con `before`. */
function newlyRequiredRoles(
  before: ClinicMfaPolicy,
  after: ClinicMfaPolicy,
): ClinicRole[] {
  if (after.requireAllMfa && !before.requireAllMfa) {
    return before.requireAdminMfa
      ? Object.values(ClinicRole).filter((r) => r !== ClinicRole.ADMIN)
      : Object.values(ClinicRole);
  }
  return after.requireAdminMfa && !before.requireAdminMfa
    ? [ClinicRole.ADMIN]
    : [];
}

function policyCode(policy: ClinicMfaPolicy): string {
  if (policy.requireAllMfa) return 'ALL_MFA_REQUIRED';
  return policy.requireAdminMfa ? 'ADMIN_MFA_REQUIRED' : 'ADMIN_MFA_OPTIONAL';
}

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
    @Inject(MFA_NOTIFIER) private readonly notifier: MfaNotifier,
  ) {}

  /** Política de la clínica: ¿a quién se exige el MFA? */
  async clinicPolicy(tenantId: string): Promise<ClinicMfaPolicy> {
    return (await this.repo.findClinicPolicy(tenantId)) ?? NO_POLICY;
  }

  /**
   * Cambia la política (solo ADMIN, lo exige la ruta). Para ENDURECERLA, quien
   * la cambia debe tener ya su propio MFA activo (si no, el siguiente login le
   * llevaría al alta forzada sin haberlo probado). `requireAllMfa` implica
   * `requireAdminMfa`; sin indicarlo se conserva. Al endurecerla se cierran
   * las sesiones de quienes quedan obligados sin tenerlo (DX-021-bis), que
   * pasan por el alta forzada en su próximo login. Auditada con el antes y el
   * después (CLINIC_SETTINGS, `MFA_POLICY`) y cuántas se cerraron; sin evento
   * si no cambia.
   */
  async setClinicPolicy(
    input: { requireAdminMfa: boolean; requireAllMfa?: boolean },
    ctx: AuditRequestContext,
  ): Promise<ClinicMfaPolicy> {
    const before = await this.clinicPolicy(ctx.tenantId);
    const requireAllMfa = input.requireAllMfa ?? before.requireAllMfa;
    const after: ClinicMfaPolicy = {
      requireAllMfa,
      requireAdminMfa: requireAllMfa || input.requireAdminMfa,
    };
    if (
      after.requireAdminMfa === before.requireAdminMfa &&
      after.requireAllMfa === before.requireAllMfa
    ) {
      return after;
    }
    const newlyBound = newlyRequiredRoles(before, after);
    if (
      newlyBound.length > 0 &&
      !(await this.state(ctx.actor.userId)).enabledAt
    ) {
      throw new ConflictException(MFA_MESSAGES.policyNeedsOwnMfa);
    }
    await this.repo.setClinicPolicy(ctx.tenantId, after, newlyBound, {
      ...auditDraftFromContext(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        metadata: {
          reason: 'MFA_POLICY',
          statusChange: { from: policyCode(before), to: policyCode(after) },
        },
      }),
    });
    return after;
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
    return isMfaRequired({
      role,
      isPlatformAdmin: state.isPlatformAdmin,
      ...(await this.clinicPolicy(tenantId)),
    });
  }

  /**
   * ¿Este miembro necesita segundo factor para abrir sesión en la clínica?
   * Activo, u obligatorio y sin activar. Lo pregunta quien emite una sesión
   * fuera del login (aceptar una invitación): ningún camino la salta.
   */
  async needsSecondFactor(
    userId: string,
    tenantId: string,
    role: ClinicRole,
  ): Promise<boolean> {
    const state = await this.state(userId);
    return (
      state.enabledAt !== null || (await this.isRequired(state, tenantId, role))
    );
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
    ctx: MfaActorContext,
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
    await this.record(mfaAuditEvent(ctx, 'MFA_ENROLLMENT_STARTED'));
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
    ctx: MfaActorContext,
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
      mfaAuditEvent(ctx, 'MFA_ENABLED'),
    );
    if (!enabled) throw new ConflictException(MFA_MESSAGES.alreadyEnabled);
    await this.lockout.clearMfa(userId);
    // Solo ids: un alta que su dueño no hizo es una contraseña robada.
    this.logger.warn({
      event: 'user_mfa.enabled',
      userId,
      tenantId: 'tenantId' in ctx ? ctx.tenantId : null,
    });
    return { ...enabled, recoveryCodes };
  }

  /**
   * Comprueba el segundo factor de un usuario con MFA activo. Cobra el
   * intento ANTES de mirar (en espera → `LoginLockedError`, 429) y solo un
   * acierto lo borra. Un código TOTP vale una vez (anti-replay por paso, en
   * una sentencia atómica); uno de recuperación, también. `null` = no vale.
   *
   * DX-021-bis: usar un código de recuperación se avisa por correo, y el fallo
   * que deja la cuenta en espera también: quien falla aquí ya conoce la
   * contraseña, así que el dueño debe saberlo (y cambiarla corta el intento:
   * ver `clearAttempts`). `tenantId`: la clínica que firma el aviso.
   */
  async verifySecondFactor(
    userId: string,
    state: UserMfaState,
    factor: SecondFactor,
    tenantId: string | null,
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
        await this.notifier.notice({
          tenantId,
          to: state.email,
          kind: 'RECOVERY_CODE_USED',
          recoveryCodesRemaining: Math.max(0, state.recoveryCodesRemaining - 1),
        });
      }
    }
    if (kind) {
      await this.lockout.clearMfa(userId);
    } else if (await this.lockout.mfaBlocked(userId)) {
      await this.notifier.notice({
        tenantId,
        to: state.email,
        kind: 'ATTEMPTS_LOCKED',
      });
    }
    return kind;
  }

  /** La contraseña cambió: quien fallaba códigos ya no puede volver a probar. */
  clearAttempts(userId: string): Promise<void> {
    return this.lockout.clearMfa(userId);
  }

  /**
   * Registra este navegador durante 30 días (DX-021-bis) y devuelve el token de
   * su cookie; aquí solo queda la huella. Nunca para un superadmin: su segundo
   * factor se pide siempre.
   */
  async trustDevice(
    userId: string,
    tokenVersion: number,
    ctx: AuditRequestContext,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.repo.addTrustedDevice({
      userId,
      tokenHash: hashDeviceToken(token),
      tokenVersion,
      label: trustedDeviceLabel(ctx.userAgent),
      expiresAt: new Date(
        Date.now() + MFA_TRUSTED_DEVICE_DAYS * 24 * 60 * 60_000,
      ),
    });
    await this.audit.record(userMfaAuditEvent(ctx, 'MFA_TRUSTED_DEVICE_ADDED'));
    return token;
  }

  /** ¿La cookie de este navegador evita pedir el código? Solo con el MFA activo. */
  async isTrustedDevice(
    userId: string,
    state: UserMfaState,
    token: string | undefined,
    ctx: AuditRequestContext,
  ): Promise<boolean> {
    if (!token || !state.enabledAt || state.isPlatformAdmin) return false;
    const trusted = await this.repo.touchTrustedDevice(
      userId,
      hashDeviceToken(token),
      state.tokenVersion,
    );
    if (trusted) {
      await this.audit.record(
        userMfaAuditEvent(ctx, 'MFA_TRUSTED_DEVICE_USED'),
      );
    }
    return trusted;
  }

  async trustedDevices(userId: string): Promise<TrustedDevice[]> {
    const state = await this.state(userId);
    return this.repo.listTrustedDevices(userId, state.tokenVersion);
  }

  /** Revoca uno o todos. `false` si no había ninguno con ese id. */
  async revokeTrustedDevices(
    userId: string,
    id: string | null,
    ctx: AuditRequestContext,
  ): Promise<boolean> {
    const revoked = await this.repo.revokeTrustedDevices(userId, id);
    if (revoked > 0) {
      await this.audit.record(
        userMfaAuditEvent(ctx, 'MFA_TRUSTED_DEVICES_REVOKED'),
      );
    }
    return revoked > 0 || id === null;
  }

  /** ¿Tiene el miembro `userId` de ESTA clínica la verificación activa? */
  async memberStatus(
    tenantId: string,
    userId: string,
  ): Promise<{ enabled: boolean; enabledAt: Date | null }> {
    if (!(await this.repo.findActiveMemberRole(tenantId, userId))) {
      throw new NotFoundException('Staff member not found');
    }
    const { enabledAt } = await this.state(userId);
    return { enabled: enabledAt !== null, enabledAt };
  }

  /**
   * DX-021-bis: un ADMIN restablece la verificación de OTRO miembro activo de
   * su clínica que perdió el móvil y sus códigos. Exige su contraseña y su
   * propio segundo factor: una sesión robada no basta. Como `users` es global,
   * tocarla solo es asunto de esta clínica si la cuenta no da acceso a otra
   * (como el desbloqueo de DX-213; el rechazo queda auditado). Nunca a un
   * superadmin. El último ADMIN no tiene quién lo haga: solo sus códigos.
   * Borra secreto y códigos, cierra sus sesiones y deja sin valor sus
   * dispositivos de confianza (`tokenVersion` + 1), audita y avisa por correo.
   */
  async resetForMember(
    targetUserId: string,
    input: {
      currentPassword: string;
      factor: SecondFactor;
      reason: MfaResetReason;
    },
    ctx: AuditRequestContext,
  ): Promise<void> {
    const actorId = ctx.actor.userId;
    if (targetUserId === actorId) {
      throw new ConflictException(MFA_MESSAGES.resetSelf);
    }
    if (!(await this.repo.findActiveMemberRole(ctx.tenantId, targetUserId))) {
      throw new NotFoundException('Staff member not found');
    }
    const actor = await this.state(actorId);
    await this.assertPassword(actor, input.currentPassword);
    if (!actor.enabledAt) {
      throw new ConflictException(MFA_MESSAGES.resetNeedsOwnMfa);
    }
    await this.assertSecondFactor(actorId, actor, input.factor, ctx.tenantId);
    const target = await this.state(targetUserId);
    if (target.isPlatformAdmin) {
      throw new ForbiddenException(MFA_MESSAGES.resetPlatformAdmin);
    }
    if (await this.repo.hasOtherActiveMemberships(targetUserId, ctx.tenantId)) {
      await this.audit.record(mfaResetAuditEvent(ctx, targetUserId, 'REFUSED'));
      throw new ConflictException(MFA_MESSAGES.resetOtherClinic);
    }
    const tv = await this.repo.disable(
      targetUserId,
      mfaResetAuditEvent(ctx, targetUserId, input.reason),
    );
    if (tv === null) throw new ConflictException(MFA_MESSAGES.notEnabled);
    await this.lockout.clearMfa(targetUserId);
    this.logger.warn({
      event: 'user_mfa.reset_by_admin',
      userId: targetUserId,
      actorId,
      tenantId: ctx.tenantId,
    });
    await this.notifier.notice({
      tenantId: ctx.tenantId,
      to: target.email,
      kind: 'RESET_BY_ADMIN',
    });
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
    await this.assertSecondFactor(userId, state, factor, ctx.tenantId);
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
    ctx: MfaActorContext,
  ): Promise<string[]> {
    const state = await this.state(userId);
    await this.assertPassword(state, currentPassword);
    if (!state.enabledAt) throw new ConflictException(MFA_MESSAGES.notEnabled);
    await this.assertSecondFactor(
      userId,
      state,
      factor,
      'tenantId' in ctx ? ctx.tenantId : null,
    );
    const codes = generateRecoveryCodes();
    const ok = await this.repo.replaceRecoveryCodes(
      userId,
      this.hashCodes(codes, userId),
      mfaAuditEvent(ctx, 'MFA_RECOVERY_CODES_REGENERATED'),
    );
    if (!ok) throw new ConflictException(MFA_MESSAGES.notEnabled);
    return codes;
  }

  private async assertSecondFactor(
    userId: string,
    state: UserMfaState,
    factor: SecondFactor,
    tenantId: string | null,
  ): Promise<void> {
    if (!(await this.verifySecondFactor(userId, state, factor, tenantId))) {
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

  /** En la auditoría de la clínica o, sin ella, en la de plataforma. */
  private async record(event: MfaAuditDraft): Promise<void> {
    if ('tenantId' in event) await this.audit.record(event);
    else await this.repo.recordPlatformEvent(event);
  }

  private hashCodes(codes: string[], userId: string): string[] {
    return codes.map((code) =>
      this.cipher.hashRecoveryCode(normalizeRecoveryCode(code)!, userId),
    );
  }
}
