import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  JwtPayload,
  isPlatformPayload,
} from '../../../../shared/crypto/token.service';
import { PLATFORM_REPOSITORY } from '../../domain/ports/platform-repository.port';
import type { PlatformRepository } from '../../domain/ports/platform-repository.port';

/**
 * Deja pasar SOLO un token de plataforma cuyo usuario siga siendo superadmin.
 * Dos condiciones a propósito:
 *  1. la forma del token (un token de clínica, por muy ADMIN que sea, no vale
 *     aquí: ADMIN es un rol por-clínica, no un permiso de plataforma), y
 *  2. un re-chequeo del flag en la DB, para que revocar `isPlatformAdmin`
 *     tenga efecto inmediato y no cuando expire el token.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repo: PlatformRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!user || !isPlatformPayload(user)) {
      throw new ForbiddenException('Platform admin only');
    }
    if (!(await this.repo.isPlatformAdmin(user.sub))) {
      throw new ForbiddenException('Platform admin only');
    }
    return true;
  }
}
