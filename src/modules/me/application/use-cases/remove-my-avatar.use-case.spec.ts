import { RemoveMyAvatarUseCase } from './remove-my-avatar.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';

function makeRepo(avatarKey: string | null) {
  const calls = { avatarKey: undefined as string | null | undefined };
  const repo = {
    findUserById: () =>
      Promise.resolve({
        id: 'u1',
        email: 'a@b',
        fullName: 'A',
        avatarKey,
        emailVerifiedAt: null,
      }),
    updateAvatarKey: (_id: string, key: string | null) => {
      calls.avatarKey = key;
      return Promise.resolve();
    },
  } as unknown as UserProfileRepository;
  return { calls, repo };
}

describe('RemoveMyAvatarUseCase', () => {
  it('deletes the stored file by its key and nulls the column', async () => {
    const { calls, repo } = makeRepo('avatars/u1.png');
    const storage = new InMemoryFileStorage();
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(storage.deleted).toEqual(['avatars/u1.png']);
    expect(calls.avatarKey).toBeNull();
  });

  it('also resolves a legacy absolute URL to its key', async () => {
    const { repo } = makeRepo('http://h/api/v1/files/avatars/u1.png');
    const storage = new InMemoryFileStorage();
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(storage.deleted).toEqual(['avatars/u1.png']);
  });

  it('is a no-op delete when there is no avatar, still nulls the column', async () => {
    const { calls, repo } = makeRepo(null);
    const storage = new InMemoryFileStorage();
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(storage.deleted).toEqual([]);
    expect(calls.avatarKey).toBeNull();
  });

  it('never deletes a key outside the avatars space, still nulls the column (DX-084)', async () => {
    const { calls, repo } = makeRepo('clinical/t1/x.pdf');
    const storage = new InMemoryFileStorage();
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(storage.deleted).toEqual([]);
    expect(calls.avatarKey).toBeNull();
  });
});
