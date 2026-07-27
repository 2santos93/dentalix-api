import { BadRequestException } from '@nestjs/common';
import { SetMyAvatarUseCase } from './set-my-avatar.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { FileStoragePort } from '../../../../shared/storage/file-storage.port';

function makeDeps(currentAvatarUrl: string | null) {
  const calls = { saved: [] as string[], deleted: [] as string[], avatarUrl: undefined as string | null | undefined };
  const repo = {
    findUserById: async () => ({ id: 'u1', email: 'a@b', fullName: 'A', avatarUrl: currentAvatarUrl, emailVerifiedAt: null }),
    updateAvatarUrl: async (_id: string, url: string | null) => { calls.avatarUrl = url; },
  } as unknown as UserProfileRepository;
  const storage: FileStoragePort = {
    save: async (ns, filename) => { calls.saved.push(`${ns}/${filename}`); return { url: `http://h/api/v1/files/${ns}/${filename}` }; },
    delete: async (ns, filename) => { calls.deleted.push(`${ns}/${filename}`); },
  };
  return { calls, repo, storage };
}

describe('SetMyAvatarUseCase', () => {
  it('saves <userId>.png and stores the returned url', async () => {
    const { calls, repo, storage } = makeDeps(null);
    const res = await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1', buffer: Buffer.from('img'), contentType: 'image/png',
    });
    expect(calls.saved).toEqual(['avatars/u1.png']);
    expect(res.avatarUrl).toBe('http://h/api/v1/files/avatars/u1.png');
    expect(calls.avatarUrl).toBe('http://h/api/v1/files/avatars/u1.png');
  });

  it('deletes the previous avatar (different ext) before saving', async () => {
    const { calls, repo, storage } = makeDeps('http://h/api/v1/files/avatars/u1.jpg');
    await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1', buffer: Buffer.from('img'), contentType: 'image/png',
    });
    expect(calls.deleted).toEqual(['avatars/u1.jpg']);
    expect(calls.saved).toEqual(['avatars/u1.png']);
  });

  it('rejects an unsupported content type', async () => {
    const { repo, storage } = makeDeps(null);
    await expect(
      new SetMyAvatarUseCase(repo, storage).execute({ userId: 'u1', buffer: Buffer.from('x'), contentType: 'application/pdf' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
