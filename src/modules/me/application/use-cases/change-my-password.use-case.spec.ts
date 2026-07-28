import { UnauthorizedException } from '@nestjs/common';
import { ChangeMyPasswordUseCase } from './change-my-password.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';

const password = new PasswordService();

function makeRepo(hash: string | null, sink: { saved?: string }): UserProfileRepository {
  return {
    getPasswordHash: async () => hash,
    updatePasswordHash: async (_userId: string, newHash: string) => {
      sink.saved = newHash;
    },
  } as unknown as UserProfileRepository;
}

describe('ChangeMyPasswordUseCase', () => {
  it('re-hashes and stores the new password when the current one matches', async () => {
    const current = await password.hash('OldPass1');
    const sink: { saved?: string } = {};
    const uc = new ChangeMyPasswordUseCase(makeRepo(current, sink), password);
    await uc.execute({ userId: 'u1', currentPassword: 'OldPass1', newPassword: 'NewPass9' });
    expect(sink.saved).toBeDefined();
    expect(await password.verify('NewPass9', sink.saved!)).toBe(true);
  });

  it('rejects when the current password is wrong', async () => {
    const current = await password.hash('OldPass1');
    const uc = new ChangeMyPasswordUseCase(makeRepo(current, {}), password);
    await expect(
      uc.execute({ userId: 'u1', currentPassword: 'WRONG', newPassword: 'NewPass9' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the user has no stored hash', async () => {
    const uc = new ChangeMyPasswordUseCase(makeRepo(null, {}), password);
    await expect(
      uc.execute({ userId: 'u1', currentPassword: 'x', newPassword: 'NewPass9' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
