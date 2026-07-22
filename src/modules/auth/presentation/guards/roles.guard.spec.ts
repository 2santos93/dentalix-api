import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';

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
    const { ctx, reflector } = makeCtx(ClinicRole.OWNER, [
      ClinicRole.OWNER,
      ClinicRole.ADMIN,
    ]);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('forbids a user whose role is not allowed', () => {
    const { ctx, reflector } = makeCtx(ClinicRole.RECEPTION, [
      ClinicRole.OWNER,
    ]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
