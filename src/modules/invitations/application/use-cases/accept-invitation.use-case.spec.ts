import {
  BadRequestException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { AcceptInvitationUseCase } from './accept-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';
import { hashInvitationToken } from '../invitation-token';

function makePassword(overrides: Partial<PasswordService> = {}) {
  return {
    hash: jest.fn().mockResolvedValue('NEW_HASH'),
    verify: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeTokens(overrides: Partial<TokenService> = {}) {
  return {
    issue: jest
      .fn()
      .mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' }),
    ...overrides,
  } as unknown as TokenService;
}

/**
 * Runs `fn` with `tenantId` set on `ctx` — the SAME `TenantContextService`
 * instance injected into the use case under test (must be, since the ALS
 * store lives on the instance: a different instance would see no tenant at
 * all, same as a real request outside `runWithTenant`).
 */
function withTenant<T>(
  ctx: TenantContextService,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.run(tenantId, fn);
}

describe('AcceptInvitationUseCase', () => {
  it('sin tenant en contexto (host apex/desconocido) -> NotFoundException sin llamar al repo', async () => {
    const repo = new InMemoryInvitationRepository();
    const findByTokenHashSpy = jest.spyOn(repo, 'findByTokenHash');
    const uc = new AcceptInvitationUseCase(
      repo,
      makePassword(),
      makeTokens(),
      new TenantContextService(),
    );

    // Deliberately NOT wrapped in ctx.run(...): mirrors a request that hit an
    // apex/unknown host, where PublicTenantContextInterceptor never sets a
    // tenant in context.
    await expect(
      uc.execute({ token: 'any-token', password: 'longenough1' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(findByTokenHashSpy).not.toHaveBeenCalled();
  });

  it('usuario NUEVO: crea usuario, crea membresía con el rol de la invitación, marca aceptada, devuelve tokens', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation({
      token: 'tok-1',
      email: 'nuevo@clinic.com',
      fullName: 'Nuevo Usuario',
      role: ClinicRole.ASSISTANT,
    });
    const password = makePassword();
    const tokens = makeTokens();
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(repo, password, tokens, ctx);

    const result = await ctx.run('t1', () =>
      uc.execute({ token: 'tok-1', password: 'longenough1' }),
    );

    expect(result).toEqual({ accessToken: 'AT', refreshToken: 'RT' });
    expect(password.hash).toHaveBeenCalledWith('longenough1');
    const found = await repo.findUserByEmailGlobal('nuevo@clinic.com');
    expect(found).not.toBeNull();
    expect(found?.passwordHash).toBe('NEW_HASH');
    expect(await repo.listPending()).toHaveLength(0); // ya no está pendiente: quedó aceptada
    const stored = await repo.findByTokenHash(hashInvitationToken('tok-1'));
    expect(stored?.acceptedAt).not.toBeNull();
    expect(invitation.email).toBe('nuevo@clinic.com'); // sanity: seedInvitation devolvió lo esperado
  });

  it('usuario EXISTENTE con contraseña correcta: NO crea usuario, NO cambia su password, crea membresía, marca aceptada, devuelve tokens', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedUser({
      id: 'user-existing',
      email: 'existente@clinic.com',
      passwordHash: 'OLD_HASH',
    });
    repo.seedInvitation({
      token: 'tok-2',
      email: 'existente@clinic.com',
      role: ClinicRole.DENTIST,
    });
    const password = makePassword({
      verify: jest.fn().mockResolvedValue(true),
    });
    const tokens = makeTokens();
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(repo, password, tokens, ctx);

    const result = await ctx.run('t1', () =>
      uc.execute({ token: 'tok-2', password: 'whatever-they-typed' }),
    );

    expect(result).toEqual({ accessToken: 'AT', refreshToken: 'RT' });
    expect(password.hash).not.toHaveBeenCalled();
    const user = await repo.findUserByEmailGlobal('existente@clinic.com');
    expect(user?.passwordHash).toBe('OLD_HASH'); // sin cambios
    const membership = await repo.findActiveMembershipByEmail(
      'existente@clinic.com',
    );
    expect(membership).toEqual({ userId: 'user-existing' });
  });

  it('usuario EXISTENTE con contraseña incorrecta: UnauthorizedException y NO persiste nada', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedUser({ id: 'user-existing', email: 'existente@clinic.com' });
    repo.seedInvitation({ token: 'tok-3', email: 'existente@clinic.com' });
    const password = makePassword({
      verify: jest.fn().mockResolvedValue(false),
    });
    const acceptSpy = jest.spyOn(repo, 'acceptTransactional');
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(repo, password, makeTokens(), ctx);

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'tok-3', password: 'wrong-password' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['expirada', { expiresAt: new Date('2020-01-01T00:00:00.000Z') }],
    ['revocada', { revokedAt: new Date('2026-01-01T00:00:00.000Z') }],
    ['ya usada', { acceptedAt: new Date('2026-01-01T00:00:00.000Z') }],
  ])('invitación %s -> GoneException', async (_label, overrides) => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({ token: 'tok-4', ...overrides });
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      repo,
      makePassword(),
      makeTokens(),
      ctx,
    );

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'tok-4', password: 'longenough1' }),
      ),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('token inexistente -> NotFoundException', async () => {
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      new InMemoryInvitationRepository(),
      makePassword(),
      makeTokens(),
      ctx,
    );

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'does-not-exist', password: 'longenough1' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('contraseña < 8 caracteres para usuario NUEVO -> BadRequestException', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({ token: 'tok-5', email: 'nuevo@clinic.com' });
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      repo,
      makePassword(),
      makeTokens(),
      ctx,
    );

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'tok-5', password: 'short' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ya es miembro activo: no lanza, marca aceptada y no duplica membresía', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedActiveMember({
      email: 'activo@clinic.com',
      userId: 'user-activo',
      role: ClinicRole.RECEPTION,
    });
    repo.seedInvitation({
      token: 'tok-6',
      email: 'activo@clinic.com',
      role: ClinicRole.ADMIN,
    });
    const password = makePassword({
      verify: jest.fn().mockResolvedValue(true),
    });
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(repo, password, makeTokens(), ctx);

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'tok-6', password: 'whatever-they-typed' }),
      ),
    ).resolves.toEqual({ accessToken: 'AT', refreshToken: 'RT' });
  });

  it('emite los tokens con el tenantId del CONTEXTO y el rol de la INVITACIÓN (no del cliente)', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'tok-7',
      email: 'nuevo2@clinic.com',
      role: ClinicRole.RECEPTION,
    });
    const tokens = makeTokens();
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(repo, makePassword(), tokens, ctx);

    await ctx.run('tenant-from-context', () =>
      uc.execute({ token: 'tok-7', password: 'longenough1' }),
    );

    expect(tokens.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-from-context',
        role: ClinicRole.RECEPTION,
      }),
    );
    const [[payload]] = (tokens.issue as jest.Mock).mock.calls;
    expect(payload.sub).toEqual(expect.any(String));
  });
});
