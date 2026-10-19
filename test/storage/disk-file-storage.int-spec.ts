import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskFileStorage } from '../../src/shared/storage/disk-file-storage';

function makeStorage(root: string): DiskFileStorage {
  return new DiskFileStorage({
    driver: 'disk',
    root,
    publicBaseUrl: 'http://files.test/api/v1/files',
  });
}

describe('DiskFileStorage (int)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dfs-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves bytes under <root>/<key>, reads them back and builds the public url', async () => {
    const storage = makeStorage(root);
    await storage.save('avatars/u1.png', Buffer.from('img'), 'image/png');
    const written = await fs.readFile(path.join(root, 'avatars', 'u1.png'));
    expect(written.toString()).toBe('img');
    const file = await storage.read('avatars/u1.png');
    expect(file?.bytes.toString()).toBe('img');
    expect(file?.contentType).toBe('image/png');
    expect(storage.publicUrl('avatars/u1.png')).toBe(
      'http://files.test/api/v1/files/avatars/u1.png',
    );
  });

  it('read returns null when missing; delete removes and is idempotent', async () => {
    const storage = makeStorage(root);
    expect(await storage.read('avatars/nope.png')).toBeNull();
    await storage.save('avatars/u1.png', Buffer.from('img'), 'image/png');
    await storage.delete('avatars/u1.png');
    await expect(
      fs.access(path.join(root, 'avatars', 'u1.png')),
    ).rejects.toBeDefined();
    await expect(storage.delete('avatars/u1.png')).resolves.toBeUndefined();
  });

  it('rejects keys that would escape the root', async () => {
    const storage = makeStorage(root);
    await expect(
      storage.save('avatars/../../etc/x', Buffer.from(''), 'image/png'),
    ).rejects.toThrow('Clave de fichero');
  });
});
