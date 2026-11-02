import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { TokenService } from '../../../../shared/crypto/token.service';
import { locationClaim } from '../../../../shared/tenancy/location-access';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from '../../domain/ports/auth-repository.port';
import { MFA_MESSAGES, type MfaChallengePurpose } from '../../domain/user-mfa';
import type { MfaLoginReason } from '../../domain/user-mfa-audit';
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

interface ChallengeSession {
  claims: MfaChallengeClaims;
  role: ClinicRole;
  allowedLocationIds: string[] | null;
}

/**
 * DX-021: segundo paso del login de clínica. Canjea el token intermedio
 * (`mfaToken`) + el segundo factor por el par de sesión de siempre (con su
 * familia de refresh nueva, como cualquier login), o completa el alta
 * forzada de quien tiene el MFA obligatorio y aún no lo activó.
 *
 * Antes de emitir nada se re-lee el estado ACTUAL: membresía activa en la
 * clínica del host y la misma `tokenVersion` que cuando se pidió el token
 * (un cambio de contraseña o de MFA entremedias lo invalida).
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
  ) {}

  async verify(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    factor: SecondFactor;
    request: AuditRequestMeta;
  }): Promise<SessionPair> {
    const session = await this.open(
      input.mfaToken,
      'MFA_VERIFY',
      input.hostTenantId,
    );
    const userId = session.claims.sub;
    const state = await this.mfa.state(userId);
    if (!state.enabledAt) throw expired();
    const kind = await this.mfa.verifySecondFactor(userId, state, input.factor);
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
    return pair;
  }

  async startEnrollment(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    request: AuditRequestMeta;
  }): Promise<UserMfaEnrollment> {
    const session = await this.open(
      input.mfaToken,
      'MFA_ENROLL',
      input.hostTenantId,
    );
    // La contraseña se verificó en el primer paso (de ahí el token).
    return this.mfa.startEnrollment(session.claims.sub, null, {
      tenantId: session.claims.tenantId,
      locationId: null,
      actor: { userId: session.claims.sub, role: session.role },
      ...input.request,
    });
  }

  async confirmEnrollment(input: {
    mfaToken: string;
    hostTenantId: string | undefined;
    code: string;
    request: AuditRequestMeta;
  }): Promise<SessionPair & { recoveryCodes: string[] }> {
    const session = await this.open(
      input.mfaToken,
      'MFA_ENROLL',
      input.hostTenantId,
    );
    const enabled = await this.mfa.confirmEnrollment(
      session.claims.sub,
      input.code,
      {
        tenantId: session.claims.tenantId,
        locationId: null,
        actor: { userId: session.claims.sub, role: session.role },
        ...input.request,
      },
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
    const role = state?.tenant?.membershipRole;
    if (!state || !role || state.tokenVersion !== claims.tv) throw expired();
    return {
      claims,
      role,
      allowedLocationIds: state.tenant!.allowedLocationIds,
    };
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

  private issue(session: ChallengeSession, tv: number): Promise<SessionPair> {
    return this.tokens.issue({
      sub: session.claims.sub,
      tenantId: session.claims.tenantId,
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
