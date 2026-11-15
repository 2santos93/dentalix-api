import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  JwtPayload,
  TenantJwtPayload,
  isTenantPayload,
} from '../../../../shared/crypto/token.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { effectivePermissions } from '../../domain/extra-permissions';
import { ROLES_DENIED_MESSAGE_KEY, ROLES_KEY } from './roles.decorator';
import { ALLOW_PERMISSIONS_KEY } from './permissions.decorator';

/**
 * DX-090: lo que el guard deja en la petición cuando la ruta declara
 * `@AllowPermissions(...)`: rol base ∪ permisos extra concedidos. Lo leen los
 * controladores que acotan por permiso (p. ej. la caja en lectura).
 */
export interface PermissionAwareRequest {
  user?: JwtPayload;
  effectivePermissions?: ExtraPermission[];
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // DX-090: global (PrismaModule). Opcional para los tests que montan el
    // guard sin BD: sin él, ninguna ruta se abre por permiso.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ClinicRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<PermissionAwareRequest>();
    const { user } = request;
    // A platform token carries no `role` (it is not scoped to any clinic), so
    // it can never satisfy a @Roles(...) requirement — the superadmin reaches
    // clinic routes with a real tenant token instead.
    if (!user || !isTenantPayload(user)) {
      throw this.denied(context);
    }
    // DX-090: solo del handler (ver `AllowPermissions`).
    const handler = context.getHandler();
    const allowed = handler
      ? this.reflector.get<ExtraPermission[] | undefined>(
          ALLOW_PERMISSIONS_KEY,
          handler,
        )
      : undefined;
    if (!allowed || allowed.length === 0) {
      if (!required.includes(user.role)) throw this.denied(context);
      return true;
    }
    return this.withPermissions(context, request, user, required, allowed);
  }

  /**
   * Rol base O permiso extra. El permiso se lee de la membresía VIGENTE en
   * cada petición (no del token): retirarlo corta el acceso en el acto, sin
   * esperar a que caduque la sesión. Solo cuentan los CONCEDIDOS: la tabla de
   * permisos de serie de cada rol describe, no abre rutas.
   */
  private async withPermissions(
    context: ExecutionContext,
    request: PermissionAwareRequest,
    user: TenantJwtPayload,
    required: ClinicRole[],
    allowed: ExtraPermission[],
  ): Promise<boolean> {
    const extra =
      user.role === ClinicRole.ADMIN ? [] : await this.grantedTo(user);
    request.effectivePermissions = effectivePermissions(user.role, extra);
    if (required.includes(user.role)) return true;
    if (allowed.some((p) => extra.includes(p))) return true;
    throw this.denied(context);
  }

  /**
   * Permisos extra de la membresía activa del usuario en la clínica del token.
   * La membresía tiene RLS: se lee dentro de `runWithTenant` con el tenant del
   * token VERIFICADO. Sin membresía activa (desactivado, break-glass): ninguno.
   */
  private async grantedTo(user: TenantJwtPayload): Promise<ExtraPermission[]> {
    if (!this.prisma) return [];
    const membership = await this.prisma.runWithTenant(user.tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: {
          tenantId: user.tenantId,
          userId: user.sub,
          deletedAt: null,
        },
        select: { extraPermissions: true },
      }),
    );
    return membership?.extraPermissions ?? [];
  }

  private denied(context: ExecutionContext): ForbiddenException {
    const message = this.reflector.getAllAndOverride<unknown>(
      ROLES_DENIED_MESSAGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    return new ForbiddenException(
      typeof message === 'string' ? message : 'Insufficient role',
    );
  }
}
