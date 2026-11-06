import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { TokenService } from '../../../../shared/crypto/token.service';
import { locationClaim } from '../../../../shared/tenancy/location-access';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../audit/domain/audit-request-context';
import { ownPlatformAccountEvent } from '../../../audit/domain/platform-audit-event';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from '../../domain/ports/auth-repository.port';
import { MFA_MESSAGES, type MfaChallengePurpose } from '../../domain/user-mfa';
import type {
  MfaActorContext,
  MfaLoginReason,
} from '../../domain/user-mfa-audit';
import {
  USER_MFA_REPOSITORY,
  type UserMfaRepository,
} from '../../domain/ports/user-mfa-repository.port';
import { LoginLockoutService } from '../login-lockout.service';
import {
  MfaChallengeService,
  expired,
  type MfaChallengeClaims,
} from '../mfa-challenge.service';
import {
  UserMfaService,
  type SecondFactor,
  type UserMfaEnrollment,
} from '../user-mfa.service';
import type { SessionPair } from './login.use-case';

/** Paso del login en una clínica o, con `role` nulo, en plataforma (apex). */
interface ChallengeSession {
  claims: MfaChallengeClaims;
  role: ClinicRole | null;
  allowedLocationIds: string[] | null;
}

/**
 * DX-021: segundo paso del login. Canjea el token intermedio
 * (`mfaToken`) + el segundo factor por el par de sesión de siempre (con su
 * familia de refresh nueva, como cualquier login), o completa el alta
 * forzada de quien tiene el MFA obligatorio y aún no lo activó.
 *
 * Antes de emitir nada se re-lee el estado ACTUAL: membresía activa en la
 * clínica del host y la misma `tokenVersion` que cuando se pidió el token
 * (un cambio de contraseña o de MFA entremedias lo invalida).
 *
 * DX-021-bis: el login del apex (superadmin) pasa por aquí con `tenantId` nulo:
 * emite una sesión de PLATAFORMA y audita en `platform_audit_events`.
 *
 * Toda alta forzada (superadmin, DX-021-bis; miembro de clínica, SEC-066) exige
 * además el código enviado al correo de la cuenta, atado al `jti` del token.
 */
@Injectable()
export class CompleteMfaLoginUseCase {
  private readonly logger = new Logger('MfaLogin');

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly challenges: MfaChallengeService,
    private readonly mfa: UserMfaService,
    private readonly tokens: TokenService,
    private readonly audit: RecordAuditEventUseCase,
    private readonly lockout: LoginLockoutService,
    @Inject(USER_MFA_REPOSITORY) private readonly mfaRepo: UserMfaRepository,
  ) {}

  async verify(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    factor: SecondFactor;
    request: AuditRequestMeta;
    rememberDevice?: boolean;
  }): Promise<SessionPair & { trustedDeviceToken?: string }> {
    const session = await this.open(
      input.mfaToken,
      'MFA_VERIFY',
      input.hostTenantId,
    );
    const userId = session.claims.sub;
    const state = await this.mfa.state(userId);
    if (!state.enabledAt) throw expired();
    const kind = await this.mfa.verifySecondFactor(
      userId,
      state,
      input.factor,
      session.claims.tenantId,
    );
    if (!kind) {
      await this.record(
        session,
        'LOGIN_FAILED',
        'INVALID_MFA_CODE',
        input.request,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'MFA_INVALID_CODE',
        message: input.factor.recoveryCode
          ? MFA_MESSAGES.invalidRecoveryCode
          : MFA_MESSAGES.invalidCode,
      });
    }
    await this.consume(session.claims);
    const pair = await this.issue(session, state.tokenVersion);
    await this.record(
      session,
      'LOGIN',
      kind === 'TOTP' ? 'MFA_TOTP' : 'MFA_RECOVERY_CODE',
      input.request,
    );
    // Nunca en plataforma: el segundo factor del superadmin se pide siempre.
    if (
      !input.rememberDevice ||
      session.role === null ||
      state.isPlatformAdmin
    ) {
      return pair;
    }
    const trustedDeviceToken = await this.mfa.trustDevice(
      userId,
      state.tokenVersion,
      this.clinicContext(session, input.request),
    );
    return { ...pair, trustedDeviceToken };
  }

  async startEnrollment(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    emailCode?: string;
    request: AuditRequestMeta;
  }): Promise<UserMfaEnrollment> {
    const session = await this.open(
      input.mfaToken,
      'MFA_ENROLL',
      input.hostTenantId,
    );
    const userId = session.claims.sub;
    await this.assertEmailCode(session, input.emailCode, input.request);
    // La contraseña se verificó en el primer paso (de ahí el token).
    return this.mfa.startEnrollment(
      userId,
      null,
      this.context(session, input.request),
    );
  }

  async confirmEnrollment(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    code: string;
    emailCode?: string;
    request: AuditRequestMeta;
  }): Promise<SessionPair & { recoveryCodes: string[] }> {
    const session = await this.open(
      input.mfaToken,
      'MFA_ENROLL',
      input.hostTenantId,
    );
    // Se repite aquí: si no, quien solo tiene la contraseña podría gastar el
    // contador del TOTP mientras el dueño escanea el QR.
    await this.assertEmailCode(session, input.emailCode, input.request);
    const enabled = await this.mfa.confirmEnrollment(
      session.claims.sub,
      input.code,
      this.context(session, input.request),
    );
    await this.consume(session.claims);
    const pair = await this.issue(session, enabled.tokenVersion);
    await this.record(session, 'LOGIN', 'MFA_ENROLLED', input.request);
    return { ...pair, recoveryCodes: enabled.recoveryCodes };
  }

  private async open(
    token: string,
    purpose: MfaChallengePurpose,
    hostTenantId: string | undefined,
  ): Promise<ChallengeSession> {
    const claims = await this.challenges.verify(token, purpose, hostTenantId);
    const state = await this.repo.findSessionState(claims.sub, claims.tenantId);
    if (!state || state.tokenVersion !== claims.tv) throw expired();
    if (claims.tenantId === null) {
      if (!state.isPlatformAdmin) throw expired();
      return { claims, role: null, allowedLocationIds: null };
    }
    const role = state.tenant?.membershipRole;
    if (!role) throw expired();
    return {
      claims,
      role,
      allowedLocationIds: state.tenant!.allowedLocationIds,
    };
  }

  /**
   * DX-021-bis, SEC-066: el alta forzada exige el código del correo, sea un
   * superadmin o un miembro de clínica. El código sale del `jti` del token, que
   * es de esa cuenta y de esa clínica (o del apex): no vale para otra.
   */
  private async assertEmailCode(
    session: ChallengeSession,
    emailCode: string | undefined,
    request: AuditRequestMeta,
  ): Promise<void> {
    const userId = session.claims.sub;
    const { jti } = session.claims;
    await this.lockout.claimMfaEnrollAttempt(userId, request.ip);
    if (!(await this.lockout.claimEnrollCodeAttempt(jti))) throw expired();
    if (!emailCode || !this.challenges.matchesEmailCode(jti, emailCode)) {
      await this.record(session, 'LOGIN_FAILED', 'INVALID_EMAIL_CODE', request);
      throw new BadRequestException(MFA_MESSAGES.emailCodeInvalid);
    }
    await this.lockout.clearEnrollCode(jti);
    await this.lockout.clearMfaEnroll(userId, request.ip);
  }

  /** Un solo uso: el `jti` del token intermedio entra en la denylist. */
  private async consume(claims: MfaChallengeClaims): Promise<void> {
    if (
      !(await this.repo.consumeRefreshToken(
        claims.jti,
        new Date(claims.exp * 1000),
      ))
    ) {
      throw expired();
    }
  }

  private clinicContext(
    session: ChallengeSession,
    request: AuditRequestMeta,
  ): AuditRequestContext {
    return {
      tenantId: session.claims.tenantId!,
      locationId: null,
      actor: { userId: session.claims.sub, role: session.role },
      ...request,
    };
  }

  private context(
    session: ChallengeSession,
    request: AuditRequestMeta,
  ): MfaActorContext {
    return session.role === null
      ? { userId: session.claims.sub, ...request }
      : this.clinicContext(session, request);
  }

  private issue(session: ChallengeSession, tv: number): Promise<SessionPair> {
    if (session.role === null) {
      this.logger.warn({
        event: 'platform_session.opened',
        userId: session.claims.sub,
      });
      return this.tokens.issue({
        sub: session.claims.sub,
        platform: true,
        mfa: true,
        tv,
      });
    }
    return this.tokens.issue({
      sub: session.claims.sub,
      tenantId: session.claims.tenantId!,
      role: session.role,
      tv,
      ...locationClaim(session.role, session.allowedLocationIds),
    });
  }

  private record(
    session: ChallengeSession,
    action: 'LOGIN' | 'LOGIN_FAILED',
    reason: MfaLoginReason,
    request: AuditRequestMeta,
  ): Promise<void> {
    if (action === 'LOGIN_FAILED') {
      this.logger.warn({
        event: 'login_mfa.failed',
        userId: session.claims.sub,
      });
    }
    if (session.claims.tenantId === null) {
      return this.mfaRepo.recordPlatformEvent(
        ownPlatformAccountEvent(
          { userId: session.claims.sub, ...request },
          action,
          reason,
        ),
      );
    }
    return this.audit.record({
      tenantId: session.claims.tenantId,
      locationId: null,
      actor: { kind: 'user', userId: session.claims.sub, role: session.role },
      action,
      resourceType: 'SESSION',
      resourceId: null,
      patient: null,
      ...request,
      metadata: { reason },
    });
  }
}
