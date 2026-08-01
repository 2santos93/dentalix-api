import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RegisterClinicUseCase } from './register-clinic.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { AuthRepository } from '../../domain/ports/auth-repository.port';

function makeRepo(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    findUserByEmail: () => Promise.resolve(null),
    findUserForAuth: () => Promise.resolve(null),
    findTenantBySubdomain: () => Promise.resolve(null),
    createClinicWithOwner: () =>
      Promise.resolve({ tenantId: 't1', userId: 'u1' }),
    findMembership: () => Promise.resolve(null),
    revokeToken: jest.fn(),
    isTokenRevoked: jest.fn(),
    ...overrides,
  };
}

describe('RegisterClinicUseCase', () => {
  const password = new PasswordService();

  it('creates a clinic + owner and normalizes the email', async () => {
    let captured: { email: string; passwordHash: string } | undefined;
    const repo = makeRepo({
      createClinicWithOwner: (input) => {
        captured = { email: input.email, passwordHash: input.passwordHash };
        return Promise.resolve({ tenantId: 't1', userId: 'u1' });
      },
    });
    const uc = new RegisterClinicUseCase(repo, password);

    const result = await uc.execute({
      clinicName: 'Sonrisa',
      subdomain: 'sonrisa',
      email: '  Owner@Clinic.COM ',
      password: 'S3cret!',
      fullName: 'Dr. Owner',
    });

    expect(result).toEqual({ tenantId: 't1', userId: 'u1' });
    expect(captured?.email).toBe('owner@clinic.com');
    expect(captured?.passwordHash).not.toBe('S3cret!');
  });

  it('rejects a taken subdomain', async () => {
    const repo = makeRepo({
      findTenantBySubdomain: () => Promise.resolve({ id: 't0' }),
    });
    const uc = new RegisterClinicUseCase(repo, password);
    await expect(
      uc.execute({
        clinicName: 'X',
        subdomain: 'taken',
        email: 'a@b.com',
        password: 'x',
        fullName: 'A',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a taken email', async () => {
    const repo = makeRepo({
      findUserByEmail: () => Promise.resolve({ id: 'u0' }),
    });
    const uc = new RegisterClinicUseCase(repo, password);
    await expect(
      uc.execute({
        clinicName: 'X',
        subdomain: 'new',
        email: 'a@b.com',
        password: 'x',
        fullName: 'A',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a P2002 unique-violation from the repo create to a 409 (ConflictException), not a raw 500', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`subdomain`)',
      { code: 'P2002', clientVersion: '6.19.3' },
    );
    const repo = makeRepo({
      createClinicWithOwner: () => Promise.reject(p2002),
    });
    const uc = new RegisterClinicUseCase(repo, password);

    await expect(
      uc.execute({
        clinicName: 'Race Condition Clinic',
        subdomain: 'racey',
        email: 'racey@b.com',
        password: 'x',
        fullName: 'A',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
