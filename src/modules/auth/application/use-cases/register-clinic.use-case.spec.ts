import { ConflictException } from '@nestjs/common';
import { RegisterClinicUseCase } from './register-clinic.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { AuthRepository } from '../../domain/ports/auth-repository.port';

function makeRepo(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    findUserByEmail: async () => null,
    findTenantBySubdomain: async () => null,
    createClinicWithOwner: async () => ({ tenantId: 't1', userId: 'u1' }),
    findMembership: async () => null,
    ...overrides,
  };
}

describe('RegisterClinicUseCase', () => {
  const password = new PasswordService();

  it('creates a clinic + owner and normalizes the email', async () => {
    let captured: { email: string; passwordHash: string } | undefined;
    const repo = makeRepo({
      createClinicWithOwner: async (input) => {
        captured = { email: input.email, passwordHash: input.passwordHash };
        return { tenantId: 't1', userId: 'u1' };
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
      findTenantBySubdomain: async () => ({ id: 't0' }),
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
    const repo = makeRepo({ findUserByEmail: async () => ({ id: 'u0' }) });
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
});
