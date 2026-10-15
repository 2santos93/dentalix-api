import { RemoveMyAvatarUseCase } from './remove-my-avatar.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { FileStoragePort } from '../../../../shared/storage/file-storage.port';

describe('RemoveMyAvatarUseCase', () => {
  it('deletes the stored file and nulls avatarUrl', async () => {
    const calls = {
      deleted: [] as string[],
      avatarUrl: undefined as string | null | undefined,
    };
    const repo = {
      findUserById: () =>
        Promise.resolve({
          id: 'u1',
          email: 'a@b',
          fullName: 'A',
          avatarUrl: 'http://h/api/v1/files/avatars/u1.png',
          emailVerifiedAt: null,
        }),
      updateAvatarUrl: (_id: string, url: string | null) => {
        calls.avatarUrl = url;
        return Promise.resolve();
      },
    } as unknown as UserProfileRepository;
    const storage: FileStoragePort = {
      save: () => Promise.resolve({ url: '' }),
      delete: (ns, filename) => {
        calls.deleted.push(`${ns}/${filename}`);
        return Promise.resolve();
      },
    };
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(calls.deleted).toEqual(['avatars/u1.png']);
    expect(calls.avatarUrl).toBeNull();
  });

  it('is a no-op delete when there is no avatar, still nulls the column', async () => {
    const calls = {
      deleted: [] as string[],
      avatarUrl: undefined as string | null | undefined,
    };
    const repo = {
      findUserById: () =>
        Promise.resolve({
          id: 'u1',
          email: 'a@b',
          fullName: 'A',
          avatarUrl: null,
          emailVerifiedAt: null,
        }),
      updateAvatarUrl: (_id: string, url: string | null) => {
        calls.avatarUrl = url;
        return Promise.resolve();
      },
    } as unknown as UserProfileRepository;
    const storage: FileStoragePort = {
      save: () => Promise.resolve({ url: '' }),
      delete: async () => {},
    };
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(calls.deleted).toEqual([]);
    expect(calls.avatarUrl).toBeNull();
  });
});
