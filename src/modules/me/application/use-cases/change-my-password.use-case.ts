import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import {
  JwtPayload,
  TokenService,
} from '../../../../shared/crypto/token.service';
import { SessionClaimsService } from '../../../auth/application/session-claims.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { passwordChangeAuditEvent } from '../../domain/own-account-audit';

export interface ChangeMyPasswordInput {
  /** Sesión del access token con el que se pide el cambio. */
  session: JwtPayload;
  currentPassword: string;
  newPassword: string;
  /**
   * DX-359: sede activa del actor (cabecera `X-Location-Id` validada o su
   * única sede) con sesión de clínica, para el evento; `null` = toda la
   * clínica o sesión de plataforma.
   */
  locationId: string | null;
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

  /**
   * DX-359: `request` es desde dónde se pide; el cambio queda auditado en su
   * transacción (clínica o plataforma, según la sesión), sin contraseña ni hash.
   */
  async execute(
    input: ChangeMyPasswordInput,
    request: AuditRequestMeta,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const userId = input.session.sub;
    // Primero la sesión: si ya no es válida (baja, superadmin revocado) se
    // rechaza sin verificar la contraseña — una sesión muerta no puede usarse
    // como oráculo de la contraseña actual — ni tocar nada.
    const { claims } = await this.sessions.current(input.session);
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
    const newHash = await this.password.hash(input.newPassword);
    const tv = await this.repo.updatePasswordAndRevokeSessions(
      userId,
      newHash,
      passwordChangeAuditEvent(claims, request, input.locationId),
    );
    return this.tokens.issue({ ...claims, tv });
  }
}
