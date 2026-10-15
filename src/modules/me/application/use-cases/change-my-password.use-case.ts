import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import {
  JwtPayload,
  TokenService,
} from '../../../../shared/crypto/token.service';
import { SessionClaimsService } from '../../../auth/application/session-claims.service';

export interface ChangeMyPasswordInput {
  /** Sesión del access token con el que se pide el cambio. */
  session: JwtPayload;
  currentPassword: string;
  newPassword: string;
}

/**
 * Cambia la contraseña y CIERRA todas las sesiones previas del usuario
 * (SEC-002): incrementa `User.tokenVersion`, con lo que /auth/refresh rechaza
 * cualquier refresh token emitido antes, incluido el del propio dispositivo.
 * Para que quien la cambió no tenga que volver a entrar, devuelve un par NUEVO
 * de la misma sesión (claims actuales + versión nueva). Los access tokens ya
 * emitidos siguen valiendo hasta su TTL (~15 min).
 */
@Injectable()
export class ChangeMyPasswordUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    private readonly password: PasswordService,
    private readonly sessions: SessionClaimsService,
    private readonly tokens: TokenService,
  ) {}

  async execute(
    input: ChangeMyPasswordInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const userId = input.session.sub;
    const hash = await this.repo.getPasswordHash(userId);
    // Mensaje genérico: no revelar si el usuario existe. La longitud mínima
    // de newPassword la valida el DTO (@MinLength(8)).
    if (!hash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await this.password.verify(input.currentPassword, hash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Antes de tocar nada: si la sesión ya no es válida (baja, cambio de
    // superadmin) se rechaza sin cambiar la contraseña.
    const { claims } = await this.sessions.current(input.session);
    const newHash = await this.password.hash(input.newPassword);
    const tv = await this.repo.updatePasswordAndRevokeSessions(userId, newHash);
    return this.tokens.issue({ ...claims, tv });
  }
}
