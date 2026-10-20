import {
  BadRequestException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  AcceptInvitationUseCase,
  INVITATION_NOT_FOUND,
} from './accept-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';
import { hashInvitationToken } from '../invitation-token';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';

function makePassword(overrides: Partial<PasswordService> = {}) {
  return {
    hash: jest.fn().mockResolvedValue('NEW_HASH'),
    verify: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeAudit() {
  const recordMock = jest.fn().mockResolvedValue(undefined);
  return Object.assign(
    { record: recordMock } as unknown as RecordAuditEventUseCase,
    { recordMock },
  );
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
      makeAudit(),
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
    const uc = new AcceptInvitationUseCase(
      repo,
      password,
      tokens,
      ctx,
      makeAudit(),
    );

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
      tokenVersion: 3,
    });
    repo.seedInvitation({
      token: 'tok-2',
      email: 'existente@clinic.com',
      role: ClinicRole.DENTIST,
    });
    const password = makePassword({
      verify: jest.fn().mockResolvedValue(true),
    });
    const issue = jest
      .fn()
      .mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
    const tokens = makeTokens({ issue });
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      repo,
      password,
      tokens,
      ctx,
      makeAudit(),
    );

    const result = await ctx.run('t1', () =>
      uc.execute({ token: 'tok-2', password: 'whatever-they-typed' }),
    );

    expect(result).toEqual({ accessToken: 'AT', refreshToken: 'RT' });
    // La sesión nace con la versión VIGENTE del usuario: si llevara 0, el
    // primer /auth/refresh la rechazaría por no coincidir.
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-existing', tv: 3 }),
    );
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
    const uc = new AcceptInvitationUseCase(
      repo,
      password,
      makeTokens(),
      ctx,
      makeAudit(),
    );

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'tok-3', password: 'wrong-password' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'expirada',
      { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
      'La invitación caducó. Pide a la clínica que te la reenvíe.',
    ],
    [
      'revocada',
      { revokedAt: new Date('2026-01-01T00:00:00.000Z') },
      'La clínica revocó esta invitación.',
    ],
    [
      'ya usada',
      { acceptedAt: new Date('2026-01-01T00:00:00.000Z') },
      'Esta invitación ya se usó.',
    ],
  ])(
    'invitación %s -> GoneException en español',
    async (_label, overrides, message) => {
      const repo = new InMemoryInvitationRepository();
      repo.seedInvitation({ token: 'tok-4', ...overrides });
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword(),
        makeTokens(),
        ctx,
        makeAudit(),
      );

      await expect(
        withTenant(ctx, 't1', () =>
          uc.execute({ token: 'tok-4', password: 'longenough1' }),
        ),
      ).rejects.toThrow(new GoneException(message));
    },
  );

  it('token inexistente (o reemplazado al reenviar) -> NotFoundException en español', async () => {
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      new InMemoryInvitationRepository(),
      makePassword(),
      makeTokens(),
      ctx,
      makeAudit(),
    );

    await expect(
      withTenant(ctx, 't1', () =>
        uc.execute({ token: 'does-not-exist', password: 'longenough1' }),
      ),
    ).rejects.toThrow(new NotFoundException(INVITATION_NOT_FOUND));
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
      makeAudit(),
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
    const uc = new AcceptInvitationUseCase(
      repo,
      password,
      makeTokens(),
      ctx,
      makeAudit(),
    );

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
    const issue = jest
      .fn<
        ReturnType<TokenService['issue']>,
        Parameters<TokenService['issue']>
      >()
      .mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
    const tokens = makeTokens({ issue });
    const ctx = new TenantContextService();
    const uc = new AcceptInvitationUseCase(
      repo,
      makePassword(),
      tokens,
      ctx,
      makeAudit(),
    );

    await ctx.run('tenant-from-context', () =>
      uc.execute({ token: 'tok-7', password: 'longenough1' }),
    );

    expect(issue).toHaveBeenCalledTimes(1);
    const [[payload]] = issue.mock.calls;
    expect(payload).toMatchObject({
      tenantId: 'tenant-from-context',
      role: ClinicRole.RECEPTION,
      tv: 0,
    });
    expect(typeof payload.sub).toBe('string');
  });

  describe('DX-029: verificación del email y reclamo de cuentas', () => {
    it('cuenta NUEVA: nace con el email verificado', async () => {
      const repo = new InMemoryInvitationRepository();
      repo.seedInvitation({ token: 'tok-new', email: 'nueva@clinic.com' });
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword(),
        makeTokens(),
        ctx,
        makeAudit(),
      );

      await ctx.run('t1', () =>
        uc.execute({ token: 'tok-new', password: 'longenough1' }),
      );

      const user = await repo.findUserByEmailGlobal('nueva@clinic.com');
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('cuenta SIN verificar y otra contraseña: la RECLAMA (nueva contraseña, sesiones invalidadas, auditoría)', async () => {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({
        id: 'user-squatted',
        email: 'dra@clinic.com',
        passwordHash: 'ATTACKER_HASH',
        tokenVersion: 2,
        emailVerifiedAt: null,
      });
      repo.seedInvitation({ token: 'tok-claim', email: 'dra@clinic.com' });
      const password = makePassword({
        verify: jest.fn().mockResolvedValue(false),
      });
      const issue = jest
        .fn()
        .mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
      const audit = makeAudit();
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        password,
        makeTokens({ issue }),
        ctx,
        audit,
      );

      await ctx.run('t1', () =>
        uc.execute({
          token: 'tok-claim',
          password: 'la-de-la-doctora',
          meta: { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-1' },
        }),
      );

      const user = repo.userById('user-squatted');
      expect(user?.passwordHash).toBe('NEW_HASH');
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      // tokenVersion + 1: los refresh/sesiones del anterior dueño mueren.
      expect(user?.tokenVersion).toBe(3);
      expect(issue).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-squatted', tv: 3 }),
      );
      expect(audit.recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          action: 'PASSWORD_RESET',
          resourceType: 'SESSION',
          metadata: { reason: 'INVITATION_ACCOUNT_CLAIM' },
          ip: '10.0.0.1',
        }),
      );
    });

    it('cuenta SIN verificar con su contraseña actual: se une, queda verificada y NO cierra sesiones', async () => {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({
        id: 'user-legacy',
        email: 'legado@clinic.com',
        tokenVersion: 4,
        emailVerifiedAt: null,
      });
      repo.seedInvitation({ token: 'tok-legacy', email: 'legado@clinic.com' });
      const audit = makeAudit();
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword(),
        makeTokens(),
        ctx,
        audit,
      );

      await ctx.run('t1', () =>
        uc.execute({ token: 'tok-legacy', password: 'su-clave-de-siempre' }),
      );

      const user = repo.userById('user-legacy');
      expect(user?.passwordHash).toBe('HASH');
      expect(user?.tokenVersion).toBe(4);
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(audit.recordMock).not.toHaveBeenCalled();
    });

    it('cuenta SIN verificar: reclamar exige una contraseña válida (8+)', async () => {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({ email: 'dra@clinic.com', emailVerifiedAt: null });
      repo.seedInvitation({ token: 'tok-short', email: 'dra@clinic.com' });
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword({ verify: jest.fn().mockResolvedValue(false) }),
        makeTokens(),
        ctx,
        makeAudit(),
      );

      await expect(
        ctx.run('t1', () =>
          uc.execute({ token: 'tok-short', password: 'corta' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cuenta VERIFICADA con contraseña incorrecta: no se puede reclamar (401 en español)', async () => {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({ id: 'user-ok', email: 'ok@clinic.com' });
      repo.seedInvitation({ token: 'tok-ok', email: 'ok@clinic.com' });
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword({ verify: jest.fn().mockResolvedValue(false) }),
        makeTokens(),
        ctx,
        makeAudit(),
      );

      await expect(
        ctx.run('t1', () =>
          uc.execute({ token: 'tok-ok', password: 'otra-clave-larga' }),
        ),
      ).rejects.toThrow(/contraseña no es correcta/);
      expect(repo.userById('user-ok')?.passwordHash).toBe('HASH');
    });
  });

  describe('DX-143 (SEC-033): el reclamo no alcanza una cuenta con acceso a otra clínica', () => {
    function claimSetup(opts: { isPlatformAdmin?: boolean } = {}): {
      repo: InMemoryInvitationRepository;
      ctx: TenantContextService;
    } {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({
        id: 'user-multi',
        email: 'dra@clinic.com',
        passwordHash: 'ORIGINAL_HASH',
        tokenVersion: 5,
        emailVerifiedAt: null,
        isPlatformAdmin: opts.isPlatformAdmin ?? false,
      });
      repo.seedInvitation({ token: 'tok-multi', email: 'dra@clinic.com' });
      return { repo, ctx: new TenantContextService() };
    }

    function makeUseCase(
      repo: InMemoryInvitationRepository,
      ctx: TenantContextService,
      audit = makeAudit(),
      password = makePassword({ verify: jest.fn().mockResolvedValue(false) }),
    ) {
      return {
        uc: new AcceptInvitationUseCase(
          repo,
          password,
          makeTokens(),
          ctx,
          audit,
        ),
        audit,
        password,
      };
    }

    function expectUntouched(repo: InMemoryInvitationRepository): void {
      const user = repo.userById('user-multi');
      expect(user?.passwordHash).toBe('ORIGINAL_HASH');
      expect(user?.tokenVersion).toBe(5);
      expect(user?.emailVerifiedAt).toBeNull();
    }

    it('cuenta SIN verificar con membresía ACTIVA en otra clínica y otra contraseña: 401 en español que remite a «¿Olvidaste tu contraseña?» y no toca nada', async () => {
      const { repo, ctx } = claimSetup();
      repo.seedMembership({ userId: 'user-multi', tenantId: 't-otra' });
      const { uc, audit, password } = makeUseCase(repo, ctx);

      const run = ctx.run('t1', () =>
        uc.execute({ token: 'tok-multi', password: 'la-del-atacante' }),
      );

      await expect(run).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(run).rejects.toThrow(/¿Olvidaste tu contraseña\?/);
      expectUntouched(repo);
      expect(password.hash).not.toHaveBeenCalled();
      expect(audit.recordMock).not.toHaveBeenCalled();
      expect(repo.isAccepted('tok-multi')).toBe(false);
      expect(repo.membershipsOf('user-multi')).toEqual([
        expect.objectContaining({ tenantId: 't-otra', deletedAt: null }),
      ]);
    });

    it('se comprueba de nuevo DENTRO de la transacción: una membresía en otra clínica que aparece entre medias también da 401 y no toca nada', async () => {
      const { repo, ctx } = claimSetup();
      // La comprobación previa no la ve (llega justo después)…
      jest
        .spyOn(repo, 'hasOtherActiveMemberships')
        .mockImplementationOnce(() => {
          repo.seedMembership({ userId: 'user-multi', tenantId: 't-otra' });
          return Promise.resolve(false);
        });
      const { uc, audit } = makeUseCase(repo, ctx);

      const run = ctx.run('t1', () =>
        uc.execute({ token: 'tok-multi', password: 'la-del-atacante' }),
      );

      await expect(run).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(run).rejects.toThrow(/¿Olvidaste tu contraseña\?/);
      expectUntouched(repo);
      expect(audit.recordMock).not.toHaveBeenCalled();
      expect(repo.isAccepted('tok-multi')).toBe(false);
    });

    it('administrador de PLATAFORMA sin verificar: tampoco se puede reclamar (401)', async () => {
      const { repo, ctx } = claimSetup({ isPlatformAdmin: true });
      const { uc } = makeUseCase(repo, ctx);

      await expect(
        ctx.run('t1', () =>
          uc.execute({ token: 'tok-multi', password: 'la-del-atacante' }),
        ),
      ).rejects.toThrow(/¿Olvidaste tu contraseña\?/);
      expectUntouched(repo);
    });

    it('una membresía BORRADA en otra clínica o una en ESTA clínica no bloquean el reclamo', async () => {
      const { repo, ctx } = claimSetup();
      repo.seedMembership({
        userId: 'user-multi',
        tenantId: 't-otra',
        deletedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      repo.seedMembership({
        userId: 'user-multi',
        tenantId: 't1',
        deletedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      const { uc, audit } = makeUseCase(repo, ctx);

      await ctx.run('t1', () =>
        uc.execute({ token: 'tok-multi', password: 'la-de-la-doctora' }),
      );

      const user = repo.userById('user-multi');
      expect(user?.passwordHash).toBe('NEW_HASH');
      expect(user?.tokenVersion).toBe(6);
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(audit.recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { reason: 'INVITATION_ACCOUNT_CLAIM' },
        }),
      );
    });

    it('con membresía en otra clínica pero SU contraseña actual: se une como siempre (no es un reclamo)', async () => {
      const { repo, ctx } = claimSetup();
      repo.seedMembership({ userId: 'user-multi', tenantId: 't-otra' });
      const { uc } = makeUseCase(
        repo,
        ctx,
        makeAudit(),
        makePassword({ verify: jest.fn().mockResolvedValue(true) }),
      );

      await ctx.run('t1', () =>
        uc.execute({ token: 'tok-multi', password: 'su-clave-de-siempre' }),
      );

      const user = repo.userById('user-multi');
      expect(user?.passwordHash).toBe('ORIGINAL_HASH');
      expect(user?.tokenVersion).toBe(5);
      expect(repo.isAccepted('tok-multi')).toBe(true);
    });
  });

  describe('sedes permitidas en el token (DX-089)', () => {
    async function acceptAs(opts: {
      role: ClinicRole;
      previous?: { allowedLocationIds: string[] | null };
    }): Promise<Record<string, unknown>> {
      const repo = new InMemoryInvitationRepository();
      repo.seedUser({
        id: 'user-x',
        email: 'x@clinic.com',
        passwordHash: 'OLD_HASH',
        tokenVersion: 1,
      });
      if (opts.previous) {
        // Membresía dada de baja (borrado lógico) que la invitación reactiva.
        repo.seedMembership({
          userId: 'user-x',
          tenantId: 't1',
          role: ClinicRole.RECEPTION,
          deletedAt: new Date('2026-01-01T00:00:00.000Z'),
          allowedLocationIds: opts.previous.allowedLocationIds,
        });
      }
      repo.seedInvitation({
        token: 'tok-loc',
        email: 'x@clinic.com',
        role: opts.role,
      });
      const issue = jest
        .fn()
        .mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
      const ctx = new TenantContextService();
      const uc = new AcceptInvitationUseCase(
        repo,
        makePassword(),
        makeTokens({ issue }),
        ctx,
        makeAudit(),
      );
      await ctx.run('t1', () =>
        uc.execute({ token: 'tok-loc', password: 'longenough1' }),
      );
      return (issue.mock.calls as Record<string, unknown>[][])[0][0];
    }

    it('membresía reactivada que estaba restringida → el token conserva `loc`', async () => {
      const payload = await acceptAs({
        role: ClinicRole.RECEPTION,
        previous: { allowedLocationIds: ['loc-a'] },
      });
      expect(payload).toEqual({
        sub: 'user-x',
        tenantId: 't1',
        role: ClinicRole.RECEPTION,
        tv: 1,
        loc: ['loc-a'],
      });
    });

    it('membresía reactivada sin restricción → sin `loc`', async () => {
      const payload = await acceptAs({
        role: ClinicRole.RECEPTION,
        previous: { allowedLocationIds: null },
      });
      expect(payload).not.toHaveProperty('loc');
    });

    it('membresía nueva → sin `loc` (todas las sedes)', async () => {
      const payload = await acceptAs({ role: ClinicRole.DENTIST });
      expect(payload).not.toHaveProperty('loc');
    });

    it('invitada como ADMIN → sin `loc`, aunque la membresía tuviera filas', async () => {
      const payload = await acceptAs({
        role: ClinicRole.ADMIN,
        previous: { allowedLocationIds: ['loc-a'] },
      });
      expect(payload).not.toHaveProperty('loc');
    });
  });
});
