import { NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { GetMyProfileUseCase } from './get-my-profile.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';

function makeRepo(over: Partial<UserProfileRepository> = {}): UserProfileRepository {
  return {
    findUserById: async () => ({
      id: 'u1',
      email: 'a@b.com',
      fullName: 'Ana',
      avatarUrl: null,
      emailVerifiedAt: null,
    }),
    findClinicName: async () => 'Clínica Sur',
    getPasswordHash: async () => 'h',
    updateName: async () => {},
    updatePasswordHash: async () => {},
    updateAvatarUrl: async () => {},
    ...over,
  };
}

describe('GetMyProfileUseCase', () => {
  it('composes the profile with the current clinic + role from the session', async () => {
    const uc = new GetMyProfileUseCase(makeRepo());
    const profile = await uc.execute({ userId: 'u1', tenantId: 't1', role: ClinicRole.DENTIST });
    expect(profile).toEqual({
      id: 'u1',
      email: 'a@b.com',
      fullName: 'Ana',
      avatarUrl: null,
      emailVerifiedAt: null,
      memberships: [{ tenantId: 't1', clinicName: 'Clínica Sur', role: ClinicRole.DENTIST }],
    });
  });

  it('throws NotFound when the user does not exist', async () => {
    const uc = new GetMyProfileUseCase(makeRepo({ findUserById: async () => null }));
    await expect(
      uc.execute({ userId: 'x', tenantId: 't1', role: ClinicRole.ADMIN }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
