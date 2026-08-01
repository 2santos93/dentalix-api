import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { LoginUseCase } from './login.use-case';
import { AuthRepository } from '../../domain/ports/auth-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';

const password = new PasswordService();

function makeRepo(
  membership: Awaited<ReturnType<AuthRepository['findMembership']>>,
): AuthRepository {
  return {
    findUserByEmail: async () => null,
    findUserForAuth: () => Promise.resolve(null),
    findTenantBySubdomain: async () => null,
    createClinicWithOwner: async () => ({ tenantId: 't1', userId: 'u1' }),
    findMembership: async () => membership,
    revokeToken: jest.fn(),
    isTokenRevoked: jest.fn(),
  };
}

const tokens = {
  issue: async () => ({ accessToken: 'acc', refreshToken: 'ref' }),
} as never;

describe('LoginUseCase', () => {
  it('returns tokens for valid credentials', async () => {
    const hash = await password.hash('S3cret!');
    const repo = makeRepo({
      userId: 'u1',
      passwordHash: hash,
      role: ClinicRole.ADMIN,
    });
    const uc = new LoginUseCase(repo, password, tokens);
    const result = await uc.execute({
      tenantId: 't1',
      email: 'A@B.com',
      password: 'S3cret!',
    });
    expect(result).toEqual({ accessToken: 'acc', refreshToken: 'ref' });
  });

  it('rejects when there is no membership', async () => {
    const uc = new LoginUseCase(makeRepo(null), password, tokens);
    await expect(
      uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const hash = await password.hash('right');
    const repo = makeRepo({
      userId: 'u1',
      passwordHash: hash,
      role: ClinicRole.ADMIN,
    });
    const uc = new LoginUseCase(repo, password, tokens);
    await expect(
      uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
