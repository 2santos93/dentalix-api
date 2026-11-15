import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import { ROLES_DENIED_DEFAULT_MESSAGE, RolesGuard } from './roles.guard';
import { ROLES_DENIED_MESSAGE_KEY, ROLES_KEY } from './roles.decorator';
import { ALLOW_PERMISSIONS_KEY } from './permissions.decorator';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';

function makeCtx(
  role: ClinicRole,
  required?: ClinicRole[],
): { ctx: ExecutionContext; reflector: Reflector } {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  return { ctx, reflector };
}

describe('RolesGuard', () => {
  it('allows when no roles are required', () => {
    const { ctx, reflector } = makeCtx(ClinicRole.RECEPTION, undefined);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a user whose role is in the required set', () => {
    const { ctx, reflector } = makeCtx(ClinicRole.ADMIN, [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
    ]);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('forbids a user whose role is not allowed', () => {
    const { ctx, reflector } = makeCtx(ClinicRole.RECEPTION, [
      ClinicRole.ADMIN,
    ]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('usa el mensaje de rechazo de la ruta si lo declara (en español)', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === ROLES_DENIED_MESSAGE_KEY
          ? 'Solo administración configura esto.'
          : [ClinicRole.ADMIN],
      );
    const ctx = makeCtx(ClinicRole.RECEPTION).ctx;
    expect(() => new RolesGuard(reflector).canActivate(ctx)).toThrow(
      new ForbiddenException('Solo administración configura esto.'),
    );
  });
});

describe('RolesGuard — DX-090: rol base O permiso extra', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';

  /** Ruta de clase `@Roles(roles)` y, en el handler, `@AllowPermissions(allowed)`. */
  function permCtx(opts: {
    role: ClinicRole;
    roles: ClinicRole[];
    allowed?: ExtraPermission[];
    granted?: ExtraPermission[] | null;
    platform?: boolean;
  }) {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === ROLES_KEY ? opts.roles : undefined,
      );
    jest
      .spyOn(reflector, 'get')
      .mockImplementation((key: unknown) =>
        key === ALLOW_PERMISSIONS_KEY ? opts.allowed : undefined,
      );
    const findFirst = jest
      .fn()
      .mockResolvedValue(
        opts.granted === null ? null : { extraPermissions: opts.granted ?? [] },
      );
    const runWithTenant = jest.fn(
      (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ clinicMembership: { findFirst } }),
    );
    const prisma = { runWithTenant } as unknown as PrismaService;
    const request: Record<string, unknown> = {
      user: opts.platform
        ? { sub: USER, platform: true }
        : { sub: USER, tenantId: TENANT, role: opts.role },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => function handler() {},
      getClass: () => null,
    } as unknown as ExecutionContext;
    return {
      guard: new RolesGuard(reflector, prisma),
      ctx,
      request,
      findFirst,
      runWithTenant,
    };
  }

  const PAYMENT = [ClinicRole.ADMIN, ClinicRole.RECEPTION];

  it('ASSISTANT sin el permiso → 403 aunque la ruta lo admita', async () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      granted: [],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('DX-111: sin @RolesDeniedMessage, el 403 dice en español que falta permiso', async () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      granted: [],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      new ForbiddenException(ROLES_DENIED_DEFAULT_MESSAGE),
    );
    expect(ROLES_DENIED_DEFAULT_MESSAGE).toBe(
      'No tienes permiso para hacer esto. Si lo necesitas, pide acceso a un administrador.',
    );
  });

  it('ASSISTANT con PAYMENT_REGISTER concedido → pasa, y deja effectivePermissions', async () => {
    const { guard, ctx, request, runWithTenant, findFirst } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      granted: [ExtraPermission.PAYMENT_REGISTER],
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.effectivePermissions).toEqual([
      ExtraPermission.PAYMENT_REGISTER,
    ]);
    // La membresía se lee bajo la RLS del tenant del token, la activa.
    expect(runWithTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, userId: USER, deletedAt: null },
      select: { extraPermissions: true },
    });
  });

  it('un permiso que la ruta no admite no abre la ruta', async () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.FINANCIAL_REPORTS_VIEW],
      granted: [ExtraPermission.PAYMENT_REGISTER],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('una ruta SIN @AllowPermissions ignora los permisos (p. ej. anular) y no consulta la BD', () => {
    const { guard, ctx, runWithTenant } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: undefined,
      granted: [ExtraPermission.PAYMENT_REGISTER],
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('los permisos de serie del rol NO abren rutas: RECEPTION no entra a un reporte por tener PAYMENT_REGISTER de serie', async () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.RECEPTION,
      roles: [ClinicRole.ADMIN],
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      granted: [],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('sin membresía activa (desactivado, break-glass) → sin permisos → 403', async () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      granted: null,
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('el rol base sigue bastando; RECEPTION con FINANCIAL_REPORTS_VIEW lo lleva en effectivePermissions', async () => {
    const { guard, ctx, request } = permCtx({
      role: ClinicRole.RECEPTION,
      roles: PAYMENT,
      allowed: [
        ExtraPermission.PAYMENT_REGISTER,
        ExtraPermission.FINANCIAL_REPORTS_VIEW,
      ],
      granted: [ExtraPermission.FINANCIAL_REPORTS_VIEW],
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.effectivePermissions).toEqual([
      ExtraPermission.PAYMENT_REGISTER,
      ExtraPermission.FINANCIAL_REPORTS_VIEW,
    ]);
  });

  it('ADMIN no consulta la BD: ya tiene todo', async () => {
    const { guard, ctx, request, runWithTenant } = permCtx({
      role: ClinicRole.ADMIN,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(runWithTenant).not.toHaveBeenCalled();
    expect(request.effectivePermissions).toEqual([
      ExtraPermission.PAYMENT_REGISTER,
      ExtraPermission.FINANCIAL_REPORTS_VIEW,
    ]);
  });

  it('un token de plataforma nunca pasa, ni por permiso', () => {
    const { guard, ctx } = permCtx({
      role: ClinicRole.ASSISTANT,
      roles: PAYMENT,
      allowed: [ExtraPermission.PAYMENT_REGISTER],
      platform: true,
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
