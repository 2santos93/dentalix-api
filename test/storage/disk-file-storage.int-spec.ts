import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DiskFileStorage } from '../../src/shared/storage/disk-file-storage';

function makeStorage(root: string): DiskFileStorage {
  const config = {
    get: (key: string) =>
      key === 'STORAGE_DIR'
        ? root
        : key === 'FILES_PUBLIC_BASE_URL'
          ? 'http://files.test/api/v1/files'
          : undefined,
  } as unknown as ConfigService;
  return new DiskFileStorage(config);
}

describe('DiskFileStorage (int)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dfs-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves bytes under <root>/<namespace>/<filename> and returns a public url', async () => {
    const storage = makeStorage(root);
    const { url } = await storage.save('avatars', 'u1.png', Buffer.from('img'), 'image/png');
    expect(url).toBe('http://files.test/api/v1/files/avatars/u1.png');
    const written = await fs.readFile(path.join(root, 'avatars', 'u1.png'));
    expect(written.toString()).toBe('img');
  });

  it('delete removes the file and is idempotent when missing', async () => {
    const storage = makeStorage(root);
    await storage.save('avatars', 'u1.png', Buffer.from('img'), 'image/png');
    await storage.delete('avatars', 'u1.png');
    await expect(fs.access(path.join(root, 'avatars', 'u1.png'))).rejects.toBeDefined();
    await expect(storage.delete('avatars', 'u1.png')).resolves.toBeUndefined();
  });
});
