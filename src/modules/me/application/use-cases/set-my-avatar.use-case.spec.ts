import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { SetMyAvatarUseCase } from './set-my-avatar.use-case';
import {
  UPLOAD_STORAGE_BUDGET_MS,
  remainingStorageBudgetMs,
} from '../../../../shared/storage/storage-budget';
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

/** Los 16 hex de la versión del avatar: el principio de su SHA-256. */
const tag = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

let dir: string;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'avatar-spec-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** El temporal que dejaría multer en disco (DX-259). */
function tempFile(bytes: Buffer): string {
  seq += 1;
  const file = path.join(dir, `upload-${seq}`);
  writeFileSync(file, bytes);
  return file;
}

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

const run = (
  deps: ReturnType<typeof makeDeps>,
  bytes: Buffer,
  contentType: string,
) =>
  new SetMyAvatarUseCase(deps.repo, deps.storage).execute({
    userId: 'u1',
    filePath: tempFile(bytes),
    contentType,
  });

describe('SetMyAvatarUseCase', () => {
  it('guardar y borrar el anterior comparten un presupuesto de almacén que cabe en los 30 s del proxy (revisión M-1)', async () => {
    const deps = makeDeps('avatars/u1-0000000000000000.png');
    const seen: (number | null)[] = [];
    const saveFile = deps.storage.saveFile.bind(deps.storage);
    jest.spyOn(deps.storage, 'saveFile').mockImplementation((...args) => {
      seen.push(remainingStorageBudgetMs());
      return saveFile(...args);
    });
    const del = deps.storage.delete.bind(deps.storage);
    jest.spyOn(deps.storage, 'delete').mockImplementation((key) => {
      seen.push(remainingStorageBudgetMs());
      return del(key);
    });
    await run(deps, PNG, 'image/png');
    expect(seen).toHaveLength(2);
    for (const ms of seen) {
      expect(ms).not.toBeNull();
      expect(ms!).toBeLessThanOrEqual(UPLOAD_STORAGE_BUDGET_MS);
    }
  });

  it('guarda avatars/<userId>-<versión>.png desde el temporal, con caché immutable, y responde su URL (DX-084, DX-259)', async () => {
    const deps = makeDeps(null);
    const res = await run(deps, PNG, 'image/png');
    const key = `avatars/u1-${tag(PNG)}.png`;
    expect(deps.storage.saved).toEqual([key]);
    expect(deps.storage.files.get(key)?.bytes).toEqual(PNG);
    expect(deps.storage.files.get(key)?.cacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(deps.calls.avatarKey).toBe(key);
    expect(res.avatarUrl).toBe(`https://api.a.app/api/v1/files/${key}`);
  });

  it('cambiar el avatar cambia su clave (y su URL) aunque sea la misma extensión, y borra el anterior', async () => {
    const first = `avatars/u1-${tag(PNG)}.png`;
    const deps = makeDeps(first);
    await deps.storage.save(first, PNG, 'image/png');
    const next = Buffer.concat([PNG, Buffer.from('nuevo')]);
    const res = await run(deps, next, 'image/png');
    const key = `avatars/u1-${tag(next)}.png`;
    expect(key).not.toBe(first);
    expect(res.avatarUrl).toBe(`https://api.a.app/api/v1/files/${key}`);
    expect(deps.storage.deleted).toEqual([first]);
    expect([...deps.storage.files.keys()]).toEqual([key]);
  });

  it('el mismo contenido otra vez es la misma clave: se reescribe, no se borra', async () => {
    const key = `avatars/u1-${tag(PNG)}.png`;
    const deps = makeDeps(key);
    await run(deps, PNG, 'image/png');
    expect(deps.storage.deleted).toEqual([]);
    expect(deps.calls.avatarKey).toBe(key);
  });

  it('un avatar de antes (sin versión o con URL absoluta) se reduce a su clave y se borra', async () => {
    for (const previous of [
      'avatars/u1.png',
      'http://localhost:3000/api/v1/files/avatars/u1.webp',
    ]) {
      const deps = makeDeps(previous);
      await run(deps, PNG, 'image/png');
      expect(deps.storage.deleted).toEqual([
        previous.startsWith('http') ? 'avatars/u1.webp' : previous,
      ]);
    }
  });

  it('rechaza un tipo no admitido', async () => {
    const deps = makeDeps(null);
    await expect(
      run(deps, Buffer.from('x'), 'application/pdf'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.storage.saved).toEqual([]);
  });

  it('acepta JPEG y WebP reales con su tipo declarado (DX-084)', async () => {
    for (const [bytes, contentType, ext] of [
      [JPEG, 'image/jpeg', 'jpg'],
      [WEBP, 'image/webp', 'webp'],
    ] as const) {
      const deps = makeDeps(null);
      await run(deps, bytes, contentType);
      expect(deps.storage.saved).toEqual([`avatars/u1-${tag(bytes)}.${ext}`]);
    }
  });

  it('rechaza un fichero cuyo contenido no es el tipo de imagen declarado (DX-084)', async () => {
    for (const [bytes, contentType] of [
      [Buffer.from('<html><script>alert(1)</script>'), 'image/png'],
      [JPEG, 'image/png'],
      [PNG, 'image/webp'],
      [Buffer.from('RIFF0000AVI '), 'image/webp'],
      [Buffer.alloc(0), 'image/jpeg'],
    ] as const) {
      const deps = makeDeps('avatars/u1.jpg');
      await expect(run(deps, bytes, contentType)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(deps.storage.saved).toEqual([]);
      expect(deps.storage.deleted).toEqual([]);
      expect(deps.calls.avatarKey).toBeUndefined();
    }
  });
});
