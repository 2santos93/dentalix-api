import { BadRequestException } from '@nestjs/common';
import { SetMyAvatarUseCase } from './set-my-avatar.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';

// Cabeceras reales de cada formato: el caso de uso mira el contenido.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

function makeDeps(currentAvatarKey: string | null) {
  const calls = { avatarKey: undefined as string | null | undefined };
  const repo = {
    findUserById: () =>
      Promise.resolve({
        id: 'u1',
        email: 'a@b',
        fullName: 'A',
        avatarKey: currentAvatarKey,
        emailVerifiedAt: null,
      }),
    updateAvatarKey: (_id: string, key: string | null) => {
      calls.avatarKey = key;
      return Promise.resolve();
    },
  } as unknown as UserProfileRepository;
  const storage = new InMemoryFileStorage('https://api.a.app/api/v1/files');
  return { calls, repo, storage };
}

describe('SetMyAvatarUseCase', () => {
  it('saves avatars/<userId>.png, stores the KEY and answers the public url (DX-084)', async () => {
    const { calls, repo, storage } = makeDeps(null);
    const res = await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1',
      buffer: PNG,
      contentType: 'image/png',
    });
    expect(storage.saved).toEqual(['avatars/u1.png']);
    expect(calls.avatarKey).toBe('avatars/u1.png');
    expect(res.avatarUrl).toBe('https://api.a.app/api/v1/files/avatars/u1.png');
  });

  it('replaces: saves the new one first, then deletes the previous (different ext)', async () => {
    const { calls, repo, storage } = makeDeps('avatars/u1.jpg');
    await storage.save('avatars/u1.jpg', Buffer.from('old'), 'image/jpeg');
    await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1',
      buffer: PNG,
      contentType: 'image/png',
    });
    expect(storage.deleted).toEqual(['avatars/u1.jpg']);
    expect([...storage.files.keys()]).toEqual(['avatars/u1.png']);
    expect(calls.avatarKey).toBe('avatars/u1.png');
  });

  it('a previous absolute URL (before DX-084) is resolved to its key and deleted', async () => {
    const { storage, repo } = makeDeps(
      'http://localhost:3000/api/v1/files/avatars/u1.webp',
    );
    await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1',
      buffer: PNG,
      contentType: 'image/png',
    });
    expect(storage.deleted).toEqual(['avatars/u1.webp']);
  });

  it('same key (png → png) is overwritten, not deleted after saving', async () => {
    const { storage, repo } = makeDeps('avatars/u1.png');
    await new SetMyAvatarUseCase(repo, storage).execute({
      userId: 'u1',
      buffer: Buffer.concat([PNG, Buffer.from('nuevo')]),
      contentType: 'image/png',
    });
    expect(storage.deleted).toEqual([]);
    expect(storage.files.get('avatars/u1.png')?.bytes).toEqual(
      Buffer.concat([PNG, Buffer.from('nuevo')]),
    );
  });

  it('rejects an unsupported content type', async () => {
    const { repo, storage } = makeDeps(null);
    await expect(
      new SetMyAvatarUseCase(repo, storage).execute({
        userId: 'u1',
        buffer: Buffer.from('x'),
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.saved).toEqual([]);
  });

  it('accepts real JPEG and WebP files under their declared type (DX-084)', async () => {
    for (const [buffer, contentType, key] of [
      [JPEG, 'image/jpeg', 'avatars/u1.jpg'],
      [WEBP, 'image/webp', 'avatars/u1.webp'],
    ] as const) {
      const { repo, storage } = makeDeps(null);
      await new SetMyAvatarUseCase(repo, storage).execute({
        userId: 'u1',
        buffer,
        contentType,
      });
      expect(storage.saved).toEqual([key]);
    }
  });

  it('rejects a file whose content is not the declared image type (DX-084)', async () => {
    for (const [buffer, contentType] of [
      [Buffer.from('<html><script>alert(1)</script>'), 'image/png'],
      [JPEG, 'image/png'],
      [PNG, 'image/webp'],
      [Buffer.from('RIFF0000AVI '), 'image/webp'],
      [Buffer.alloc(0), 'image/jpeg'],
    ] as const) {
      const { calls, repo, storage } = makeDeps('avatars/u1.jpg');
      await expect(
        new SetMyAvatarUseCase(repo, storage).execute({
          userId: 'u1',
          buffer,
          contentType,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.saved).toEqual([]);
      expect(storage.deleted).toEqual([]);
      expect(calls.avatarKey).toBeUndefined();
    }
  });
});
