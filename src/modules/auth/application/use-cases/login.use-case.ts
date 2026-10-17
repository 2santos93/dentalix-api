import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
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

export interface PlatformLoginInput {
  email: string;
  password: string;
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
  ip?: string | null;
  userAgent?: string | null;
}

export type SessionPair = { accessToken: string; refreshToken: string };

/** Login de clínica: el par de siempre, o la sesión break-glass (sin refresh). */
export type LoginResult = SessionPair | BreakGlassSession;

export function isBreakGlassSession(
  result: LoginResult,
): result is BreakGlassSession {
  return 'breakGlass' in result && result.breakGlass === true;
}

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly breakGlass: BreakGlassService,
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
    return this.tokens.issue({
      sub: membership.userId,
      tenantId: input.tenantId,
      role: membership.role,
      tv: membership.tokenVersion,
    });
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
   */
  async executePlatform(
    input: PlatformLoginInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const email = input.email.trim().toLowerCase();
    const user = await this.repo.findUserForAuth(email);
    if (!user || !user.isPlatformAdmin) {
      return this.rejectAfterDummyVerify(input.password);
    }
    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    this.logger.warn(`Platform admin session opened: user=${user.id}`);
    return this.tokens.issue({
      sub: user.id,
      platform: true,
      tv: user.tokenVersion,
    });
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
