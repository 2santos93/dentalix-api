import { NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { GetMyProfileUseCase } from './get-my-profile.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';

function makeRepo(
  over: Partial<UserProfileRepository> = {},
): UserProfileRepository {
  return {
    findUserById: () =>
      Promise.resolve({
        id: 'u1',
        email: 'a@b.com',
        fullName: 'Ana',
        avatarKey: null,
        emailVerifiedAt: null,
      }),
    findClinicName: () => Promise.resolve('Clínica Sur'),
    getPasswordHash: () => Promise.resolve('h'),
    updateName: async () => {},
    updatePasswordAndRevokeSessions: () => Promise.resolve(1),
    updateAvatarKey: async () => {},
    ...over,
  };
}

const withAvatar = (avatarKey: string) =>
  makeRepo({
    findUserById: () =>
      Promise.resolve({
        id: 'u1',
        email: 'a@b.com',
        fullName: 'Ana',
        avatarKey,
        emailVerifiedAt: null,
      }),
  });

describe('GetMyProfileUseCase', () => {
  it('composes the profile with the current clinic + role from the session', async () => {
    const uc = new GetMyProfileUseCase(makeRepo(), new InMemoryFileStorage());
    const profile = await uc.execute({
      userId: 'u1',
      tenantId: 't1',
      role: ClinicRole.DENTIST,
    });
    expect(profile).toEqual({
      id: 'u1',
      email: 'a@b.com',
      fullName: 'Ana',
      avatarUrl: null,
      emailVerifiedAt: null,
      memberships: [
        { tenantId: 't1', clinicName: 'Clínica Sur', role: ClinicRole.DENTIST },
      ],
    });
  });

  it('DX-084: cambiar FILES_PUBLIC_BASE_URL no rompe el avatar guardado (la URL se calcula al responder)', async () => {
    const input = { userId: 'u1', tenantId: 't1', role: ClinicRole.DENTIST };
    const before = await new GetMyProfileUseCase(
      withAvatar('avatars/u1.png'),
      new InMemoryFileStorage('http://localhost:3000/api/v1/files'),
    ).execute(input);
    const after = await new GetMyProfileUseCase(
      withAvatar('avatars/u1.png'),
      new InMemoryFileStorage('https://api.dentalix.app/api/v1/files'),
    ).execute(input);
    expect(before.avatarUrl).toBe(
      'http://localhost:3000/api/v1/files/avatars/u1.png',
    );
    expect(after.avatarUrl).toBe(
      'https://api.dentalix.app/api/v1/files/avatars/u1.png',
    );
  });

  it('throws NotFound when the user does not exist', async () => {
    const uc = new GetMyProfileUseCase(
      makeRepo({ findUserById: () => Promise.resolve(null) }),
      new InMemoryFileStorage(),
    );
    await expect(
      uc.execute({ userId: 'x', tenantId: 't1', role: ClinicRole.ADMIN }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
