import { ClinicRole } from '@prisma/client';
import { LogoutUseCase } from './logout.use-case';

describe('LogoutUseCase', () => {
  const decoded = {
    sub: 'u1',
    tenantId: 't1',
    role: ClinicRole.OWNER,
    jti: 'jti-1',
    exp: 1893456000, // 2030-01-01
  };

  it('revokes the jti of a valid refresh token', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockResolvedValue(decoded),
    } as never;
    const repo = {
      revokeToken: jest.fn().mockResolvedValue(undefined),
    } as never;

    const uc = new LogoutUseCase(tokens, repo);
    await uc.execute({ refreshToken: 'good-ref' });

    expect(
      (repo as { revokeToken: jest.Mock }).revokeToken,
    ).toHaveBeenCalledWith('jti-1', new Date(decoded.exp * 1000));
  });

  it('is a silent no-op when the refresh token is invalid/expired', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockRejectedValue(new Error('bad token')),
    } as never;
    const repo = { revokeToken: jest.fn() } as never;

    const uc = new LogoutUseCase(tokens, repo);
    // No lanza: cerrar sesión nunca falla ruidosamente.
    await expect(
      uc.execute({ refreshToken: 'garbage' }),
    ).resolves.toBeUndefined();
    expect(
      (repo as { revokeToken: jest.Mock }).revokeToken,
    ).not.toHaveBeenCalled();
  });
});
