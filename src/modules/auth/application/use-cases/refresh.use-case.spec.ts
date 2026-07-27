import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { RefreshUseCase } from './refresh.use-case';

describe('RefreshUseCase', () => {
  const payload = {
    sub: 'u1',
    tenantId: 't1',
    role: ClinicRole.OWNER,
  };

  it('verifies the refresh token and issues a fresh token pair (rotation)', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockResolvedValue(payload),
      issue: jest
        .fn()
        .mockResolvedValue({ accessToken: 'new-acc', refreshToken: 'new-ref' }),
    } as never;

    const uc = new RefreshUseCase(tokens);
    const result = await uc.execute({ refreshToken: 'old-ref' });

    expect(result).toEqual({ accessToken: 'new-acc', refreshToken: 'new-ref' });
    // Re-issues from the verified payload — same identity, new tokens.
    expect((tokens as unknown as { issue: jest.Mock }).issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.OWNER,
    });
  });

  it('rejects when the refresh token is invalid/expired', async () => {
    const tokens = {
      verifyRefresh: jest.fn().mockRejectedValue(new Error('bad token')),
      issue: jest.fn(),
    } as never;

    const uc = new RefreshUseCase(tokens);
    await expect(
      uc.execute({ refreshToken: 'garbage' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Never mints tokens off an unverified refresh token.
    expect((tokens as unknown as { issue: jest.Mock }).issue).not.toHaveBeenCalled();
  });
});
