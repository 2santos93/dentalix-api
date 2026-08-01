import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import {
  JwtPayload,
  isTenantPayload,
} from '../../../../shared/crypto/token.service';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ClinicRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: JwtPayload }>();
    // A platform token carries no `role` (it is not scoped to any clinic), so
    // it can never satisfy a @Roles(...) requirement — the superadmin reaches
    // clinic routes with a real tenant token instead.
    if (!user || !isTenantPayload(user) || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
