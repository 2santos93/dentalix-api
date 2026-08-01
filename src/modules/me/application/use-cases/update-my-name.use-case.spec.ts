import { BadRequestException } from '@nestjs/common';
import { UpdateMyNameUseCase } from './update-my-name.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';

describe('UpdateMyNameUseCase', () => {
  it('trims and persists the name', async () => {
    let saved: { userId: string; fullName: string } | null = null;
    const repo = {
      updateName: async (userId: string, fullName: string) => {
        saved = { userId, fullName };
      },
    } as unknown as UserProfileRepository;
    await new UpdateMyNameUseCase(repo).execute({
      userId: 'u1',
      fullName: '  Ana Gómez  ',
    });
    expect(saved).toEqual({ userId: 'u1', fullName: 'Ana Gómez' });
  });

  it('rejects an empty name', async () => {
    const repo = {
      updateName: async () => {},
    } as unknown as UserProfileRepository;
    await expect(
      new UpdateMyNameUseCase(repo).execute({ userId: 'u1', fullName: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
