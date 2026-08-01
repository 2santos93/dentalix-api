import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';

export interface PlatformLoginInput {
  email: string;
  password: string;
}

export interface LoginInput {
  tenantId: string;
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute(
    input: LoginInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const email = input.email.trim().toLowerCase();
    const membership = await this.repo.findMembership(input.tenantId, email);
    if (!membership) {
      // Sin membresía en esta clínica: solo puede pasar el superadmin de
      // plataforma, que por diseño no es miembro de las clínicas de los
      // clientes. Entra con rol ADMIN en el tenant del host — no hay bypass de
      // RLS en ningún punto: recibe un token de clínica normal.
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
    });
  }

  private async loginAsPlatformAdminInTenant(
    email: string,
    input: LoginInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.repo.findUserForAuth(email);
    // Mismo error en todos los casos: nunca revelar si el email existe, si
    // pertenece a la clínica o si es superadmin.
    if (!user || !user.isPlatformAdmin) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Auditoría mínima acordada: queda rastro de qué superadmin entró a qué
    // clínica y cuándo (el timestamp lo pone el logger).
    this.logger.warn(
      `Platform admin access: user=${user.id} entered tenant=${input.tenantId} as ADMIN`,
    );
    return this.tokens.issue({
      sub: user.id,
      tenantId: input.tenantId,
      role: ClinicRole.ADMIN,
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
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    this.logger.warn(`Platform admin session opened: user=${user.id}`);
    return this.tokens.issue({ sub: user.id, platform: true });
  }
}
