import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import {
  DUMMY_PASSWORD_HASH,
  PasswordService,
} from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';
import {
  BreakGlassService,
  type BreakGlassSession,
} from '../break-glass.service';
import { locationClaim } from '../../../../shared/tenancy/location-access';
import {
  MFA_CHALLENGE_TTL_SECONDS,
  type MfaChallenge,
  type MfaChallengePurpose,
} from '../../domain/user-mfa';
import { LoginLockedError } from '../../domain/login-lockout';
import {
  MFA_ENROLLMENT_CODE_INTERVAL_SECONDS,
  MFA_NOTIFIER,
  type MfaNotifier,
} from '../../domain/ports/mfa-notifier.port';
import { currentRequestId } from '../../../../shared/observability/request-context';
import { MfaChallengeService } from '../mfa-challenge.service';
import { UserMfaService } from '../user-mfa.service';

export interface PlatformLoginInput {
  email: string;
  password: string;
  ip?: string | null;
}

export interface LoginInput {
  tenantId: string;
  email: string;
  password: string;
  /**
   * SEC-008: solo cuentan para el acceso break-glass del superadmin a una
   * clínica en la que no es miembro. Un miembro que los mande no nota nada.
   */
  mfaCode?: string;
  breakGlassReason?: string;
  /** DX-021-bis: token de la cookie de dispositivo de confianza, si la trae. */
  trustedDeviceToken?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type SessionPair = { accessToken: string; refreshToken: string };

/**
 * Login de clínica: el par de siempre, la sesión break-glass (sin refresh) o,
 * DX-021, el paso del segundo factor (sin ningún token con acceso a datos).
 */
export type LoginResult = SessionPair | BreakGlassSession | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return 'mfa' in result && typeof result.mfa === 'string';
}

export function isBreakGlassSession(
  result: LoginResult,
): result is BreakGlassSession {
  return 'breakGlass' in result && result.breakGlass === true;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly breakGlass: BreakGlassService,
    private readonly mfa: UserMfaService,
    private readonly challenges: MfaChallengeService,
    @Inject(MFA_NOTIFIER) private readonly notifier: MfaNotifier,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const membership = await this.repo.findMembership(input.tenantId, email);
    if (!membership) {
      // Sin membresía en esta clínica: solo puede pasar el superadmin de
      // plataforma, que por diseño no es miembro de las clínicas de los
      // clientes, y solo como acceso break-glass (SEC-008): MFA + motivo,
      // token ADMIN corto sin refresh y fila en platform_access_audit. No hay
      // bypass de RLS en ningún punto.
      return this.loginAsPlatformAdminInTenant(email, input);
    }
    const ok = await this.password.verify(
      input.password,
      membership.passwordHash,
    );
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // DX-021: con la contraseña correcta, el segundo factor. Activo → se pide
    // el código; obligatorio y sin activar → alta forzada. En ambos casos
    // solo un token intermedio, que no abre ninguna ruta de datos.
    const mfa = await this.mfa.state(membership.userId);
    // DX-021-bis: este navegador superó el código hace menos de 30 días.
    const trusted = await this.mfa.isTrustedDevice(
      membership.userId,
      mfa,
      input.trustedDeviceToken,
      {
        tenantId: input.tenantId,
        locationId: null,
        actor: { userId: membership.userId, role: membership.role },
        requestId: currentRequestId() ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    );
    const purpose = trusted
      ? null
      : mfa.enabledAt
        ? ('MFA_VERIFY' as const)
        : (await this.mfa.isRequired(mfa, input.tenantId, membership.role))
          ? ('MFA_ENROLL' as const)
          : null;
    if (purpose) {
      return this.challenge(
        {
          userId: membership.userId,
          email: mfa.email,
          isPlatformAdmin: mfa.isPlatformAdmin,
          tokenVersion: membership.tokenVersion,
        },
        input.tenantId,
        purpose,
        input.ip ?? null,
      );
    }
    return this.tokens.issue({
      sub: membership.userId,
      tenantId: input.tenantId,
      role: membership.role,
      tv: membership.tokenVersion,
      ...locationClaim(membership.role, membership.allowedLocationIds),
    });
  }

  /**
   * El paso del segundo factor. El alta de un superadmin exige además un
   * código enviado a su correo (DX-021-bis): quien solo tiene la contraseña no
   * puede enrolar su móvil, y el dueño se entera del intento.
   */
  private async challenge(
    user: {
      userId: string;
      email: string;
      isPlatformAdmin: boolean;
      tokenVersion: number;
    },
    tenantId: string | null,
    purpose: MfaChallengePurpose,
    ip: string | null,
  ): Promise<MfaChallenge> {
    const { token, expiresAt, jti } = await this.challenges.issue({
      userId: user.userId,
      tenantId,
      tokenVersion: user.tokenVersion,
      purpose,
    });
    const emailCodeRef =
      purpose === 'MFA_ENROLL' && user.isPlatformAdmin
        ? this.challenges.emailCodeRef(jti)
        : null;
    if (emailCodeRef) {
      const sent = await this.notifier.sendEnrollmentCode({
        userId: user.userId,
        ip,
        to: user.email,
        code: this.challenges.emailCode(jti),
        ref: emailCodeRef,
        expiresInMinutes: MFA_CHALLENGE_TTL_SECONDS.MFA_ENROLL / 60,
      });
      // Nunca «te enviamos un código» si no salió: este token no tendría código.
      if (!sent)
        throw new LoginLockedError(MFA_ENROLLMENT_CODE_INTERVAL_SECONDS);
    }
    return {
      mfa:
        purpose === 'MFA_VERIFY' ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
      mfaToken: token,
      expiresAt,
      ...(emailCodeRef
        ? { emailCodeRequired: true as const, emailCodeRef }
        : {}),
    };
  }

  private async loginAsPlatformAdminInTenant(
    email: string,
    input: LoginInput,
  ): Promise<BreakGlassSession> {
    const user = await this.repo.findUserForAuth(email);
    // Mismo error en todos los casos: nunca revelar si el email existe, si
    // pertenece a la clínica o si es superadmin. Tampoco por TIEMPO (SEC-017):
    // se paga el mismo argon2 que con un usuario real.
    if (!user || !user.isPlatformAdmin) {
      return this.rejectAfterDummyVerify(input.password);
    }
    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Contraseña correcta de un superadmin: a partir de aquí las respuestas
    // pueden pedir el paso siguiente (MFA / motivo) sin filtrar nada a quien
    // no la conoce.
    return this.breakGlass.open({
      tenantId: input.tenantId,
      user,
      mfaCode: input.mfaCode,
      reason: input.breakGlassReason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  /**
   * Login en el APEX (host sin tenant). Solo lo resuelve un superadmin de
   * plataforma, y devuelve un token de PLATAFORMA (sin tenant ni rol) que
   * únicamente sirve para las rutas `/platform/*`.
   *
   * DX-021-bis: la contraseña no basta. Sale el paso del segundo factor (o,
   * sin MFA, su alta) y la sesión la emite `CompleteMfaLoginUseCase`.
   */
  async executePlatform(input: PlatformLoginInput): Promise<MfaChallenge> {
    const email = input.email.trim().toLowerCase();
    const user = await this.repo.findUserForAuth(email);
    if (!user || !user.isPlatformAdmin) {
      return this.rejectAfterDummyVerify(input.password);
    }
    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const mfa = await this.mfa.state(user.id);
    return this.challenge(
      {
        userId: user.id,
        email: mfa.email,
        isPlatformAdmin: true,
        tokenVersion: mfa.tokenVersion,
      },
      null,
      mfa.enabledAt ? 'MFA_VERIFY' : 'MFA_ENROLL',
      input.ip ?? null,
    );
  }

  /**
   * SEC-017: ejecuta argon2 contra un hash ficticio constante y responde 401
   * con el mismo mensaje genérico. Sin esto, un email inexistente respondía
   * antes (sin argon2) que uno real, y el tiempo delataba qué emails usan
   * Dentalix. El resultado de la verificación se descarta: nunca puede abrir
   * sesión.
   */
  private async rejectAfterDummyVerify(plain: string): Promise<never> {
    await this.password.verify(plain, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedException('Invalid credentials');
  }
}
