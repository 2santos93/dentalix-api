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
      findUserById: async () => ({
        id: 'u1',
        email: 'a@b',
        fullName: 'A',
        avatarUrl: 'http://h/api/v1/files/avatars/u1.png',
        emailVerifiedAt: null,
      }),
      updateAvatarUrl: async (_id: string, url: string | null) => {
        calls.avatarUrl = url;
      },
    } as unknown as UserProfileRepository;
    const storage: FileStoragePort = {
      save: async () => ({ url: '' }),
      delete: async (ns, filename) => {
        calls.deleted.push(`${ns}/${filename}`);
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
      findUserById: async () => ({
        id: 'u1',
        email: 'a@b',
        fullName: 'A',
        avatarUrl: null,
        emailVerifiedAt: null,
      }),
      updateAvatarUrl: async (_id: string, url: string | null) => {
        calls.avatarUrl = url;
      },
    } as unknown as UserProfileRepository;
    const storage: FileStoragePort = {
      save: async () => ({ url: '' }),
      delete: async () => {},
    };
    await new RemoveMyAvatarUseCase(repo, storage).execute({ userId: 'u1' });
    expect(calls.deleted).toEqual([]);
    expect(calls.avatarUrl).toBeNull();
  });
});
