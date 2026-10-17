import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { ROLES_DENIED_MESSAGE_KEY } from './roles.decorator';

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
