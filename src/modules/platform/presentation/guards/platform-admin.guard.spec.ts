import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { PlatformAdminGuard } from './platform-admin.guard';
import type { PlatformRepository } from '../../domain/ports/platform-repository.port';
import { JwtPayload } from '../../../../shared/crypto/token.service';

function contextWith(user: JwtPayload | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeRepo(isPlatformAdmin: boolean): PlatformRepository {
  return {
    listTenants: () => Promise.resolve([]),
    isPlatformAdmin: () => Promise.resolve(isPlatformAdmin),
  };
}

describe('PlatformAdminGuard', () => {
  it('deja pasar un token de plataforma cuyo usuario sigue siendo superadmin', async () => {
    const guard = new PlatformAdminGuard(makeRepo(true));
    await expect(
      guard.canActivate(contextWith({ sub: 'super-1', platform: true })),
    ).resolves.toBe(true);
  });

  it('rechaza un token de CLÍNICA aunque su rol sea ADMIN — ADMIN es por-clínica, no de plataforma', async () => {
    const guard = new PlatformAdminGuard(makeRepo(true));
    await expect(
      guard.canActivate(
        contextWith({ sub: 'u1', tenantId: 't1', role: ClinicRole.ADMIN }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza si el flag fue revocado en la DB, aunque el token siga vigente', async () => {
    // Este es el motivo de re-consultar la DB en vez de confiar en el token:
    // quitar isPlatformAdmin debe surtir efecto YA, no cuando el token expire.
    const guard = new PlatformAdminGuard(makeRepo(false));
    await expect(
      guard.canActivate(contextWith({ sub: 'super-1', platform: true })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza cuando no hay usuario en la request', async () => {
    const guard = new PlatformAdminGuard(makeRepo(true));
    await expect(
      guard.canActivate(contextWith(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
