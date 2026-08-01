import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { RefreshUseCase } from './refresh.use-case';

describe('RefreshUseCase', () => {
  const payload = {
    sub: 'u1',
    tenantId: 't1',
    role: ClinicRole.ADMIN,
    jti: 'jti-1',
    exp: 1893456000,
  };

  it('verifies the refresh token and issues a fresh token pair (rotation)', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockResolvedValue(payload),
      issue: jest
        .fn()
        .mockResolvedValue({ accessToken: 'new-acc', refreshToken: 'new-ref' }),
    } as never;
    const repo = {
      isTokenRevoked: jest.fn().mockResolvedValue(false),
    } as never;

    const uc = new RefreshUseCase(tokens, repo);
    const result = await uc.execute({ refreshToken: 'old-ref' });

    expect(result).toEqual({ accessToken: 'new-acc', refreshToken: 'new-ref' });
    expect(
      (tokens as unknown as { issue: jest.Mock }).issue,
    ).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.ADMIN,
    });
  });

  it('rejects when the refresh token is invalid/expired', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockRejectedValue(new Error('bad token')),
      issue: jest.fn(),
    } as never;
    const repo = { isTokenRevoked: jest.fn() } as never;

    const uc = new RefreshUseCase(tokens, repo);
    await expect(
      uc.execute({ refreshToken: 'garbage' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      (tokens as unknown as { issue: jest.Mock }).issue,
    ).not.toHaveBeenCalled();
  });

  it('rejects when the refresh token has been revoked (logout)', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockResolvedValue(payload),
      issue: jest.fn(),
    } as never;
    const repo = { isTokenRevoked: jest.fn().mockResolvedValue(true) } as never;

    const uc = new RefreshUseCase(tokens, repo);
    await expect(
      uc.execute({ refreshToken: 'revoked-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // No re-emite tokens de una sesión ya cerrada.
    expect(
      (tokens as unknown as { issue: jest.Mock }).issue,
    ).not.toHaveBeenCalled();
  });
});
