import { ClinicRole } from '@prisma/client';
import { GetInvitationUseCase } from './get-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

/**
 * Runs `fn` with `tenantId` set on `ctx` — the SAME `TenantContextService`
 * instance injected into the use case under test (the ALS store lives on the
 * instance, so a different instance would see no tenant at all).
 */
function withTenant<T>(
  ctx: TenantContextService,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.run(tenantId, fn) as Promise<T>;
}

describe('GetInvitationUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sin tenant en contexto (host apex/desconocido) -> NOT_FOUND sin llamar al repo', async () => {
    const repo = new InMemoryInvitationRepository();
    const findByTokenHashSpy = jest.spyOn(repo, 'findByTokenHash');
    const uc = new GetInvitationUseCase(new TenantContextService(), repo);

    // Deliberately NOT wrapped in ctx.run(...): mirrors a request that hit an
    // apex/unknown host, where PublicTenantContextInterceptor never sets a
    // tenant in context.
    const result = await uc.execute('any-token');

    expect(result).toEqual({ status: 'NOT_FOUND' });
    expect(findByTokenHashSpy).not.toHaveBeenCalled();
  });

  it('token inexistente -> NOT_FOUND sin otros campos', async () => {
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, new InMemoryInvitationRepository());

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('does-not-exist'),
    );

    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  it('invitación expirada -> status EXPIRED sin clinicName/role/maskedEmail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'expired-token',
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('expired-token'),
    );

    expect(result.status).toBe('EXPIRED');
    expect(result).not.toHaveProperty('clinicName');
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('maskedEmail');
  });

  it('invitación usada -> status USED sin clinicName/role/maskedEmail', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'used-token',
      acceptedAt: new Date('2026-07-15T00:00:00.000Z'),
    });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () => uc.execute('used-token'));

    expect(result).toEqual({ status: 'USED' });
  });

  it('invitación revocada -> status REVOKED sin clinicName/role/maskedEmail', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'revoked-token',
      revokedAt: new Date('2026-07-15T00:00:00.000Z'),
    });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('revoked-token'),
    );

    expect(result).toEqual({ status: 'REVOKED' });
  });

  it('invitación válida -> email enmascarado, role, clinicName y userExists', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.tenantName = 'Sonrisas SAS';
    repo.seedInvitation({
      token: 'valid-token',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
    });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('valid-token'),
    );

    expect(result).toEqual({
      status: 'VALID',
      clinicName: 'Sonrisas SAS',
      role: ClinicRole.DENTIST,
      maskedEmail: 'an***@clinic.com',
      userExists: false,
    });
  });

  it('invitación válida con usuario ya existente -> userExists true', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedUser({ email: 'ana@clinic.com' });
    repo.seedInvitation({ token: 'valid-token', email: 'ana@clinic.com' });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('valid-token'),
    );

    expect(result.userExists).toBe(true);
  });

  it('invitación válida pero el tenant fue borrado (findTenantName -> null) -> clinicName ausente, no rompe', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.tenantName = null;
    repo.seedInvitation({ token: 'valid-token', email: 'ana@clinic.com' });
    const ctx = new TenantContextService();
    const uc = new GetInvitationUseCase(ctx, repo);

    const result = await withTenant(ctx, 't1', () =>
      uc.execute('valid-token'),
    );

    expect(result.status).toBe('VALID');
    expect(result).not.toHaveProperty('clinicName');
  });
});
