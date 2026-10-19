import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { contentTypeOf } from './content-type';
import { assertFileKey, isFileKey, publicFileUrl } from './file-key';
import {
  FileStoragePort,
  StoredFile,
  assertSignedUrlTtl,
} from './file-storage.port';
import type { DiskStorageConfig } from './storage-config';

/**
 * Adaptador de DISCO del `FileStoragePort`: solo desarrollo y tests
 * (`validateEnv` lo prohíbe en producción, DX-084). Guarda en
 * `STORAGE_DIR/<clave>`.
 *
 * Las URL firmadas apuntan a `FILES_PUBLIC_BASE_URL/signed` (FilesController)
 * con un HMAC de la clave y la caducidad. La clave del HMAC es aleatoria por
 * proceso: un reinicio invalida las URL emitidas, lo que en local da igual (y
 * el disco no se comparte entre réplicas de todos modos).
 */
export class DiskFileStorage implements FileStoragePort {
  private readonly signingKey = randomBytes(32);

  constructor(private readonly cfg: DiskStorageConfig) {}

  private pathOf(key: string): string {
    assertFileKey(key);
    return path.join(this.cfg.root, ...key.split('/'));
  }

  async save(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const file = this.pathOf(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }

  async read(key: string): Promise<StoredFile | null> {
    const file = this.pathOf(key);
    try {
      return {
        bytes: await fs.readFile(file),
        contentType: contentTypeOf(key),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // force: true → no lanza si el archivo no existe (idempotente).
    await fs.rm(this.pathOf(key), { force: true });
  }

  publicUrl(key: string): string {
    assertFileKey(key);
    return publicFileUrl(this.cfg.publicBaseUrl, key);
  }

  getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    // Dentro de la promesa: una clave o un TTL inválidos rechazan, no lanzan.
    return Promise.resolve().then(() => {
      assertFileKey(key);
      assertSignedUrlTtl(ttlSeconds);
      const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
      const query = new URLSearchParams({
        key,
        expires,
        signature: this.sign(key, expires),
      });
      return `${publicFileUrl(this.cfg.publicBaseUrl, 'signed')}?${query.toString()}`;
    });
  }

  /** true si la firma es de este proceso, para esa clave, y no ha caducado. */
  verifySignedUrl(key: string, expires: string, signature: string): boolean {
    if (!isFileKey(key) || !/^\d{1,12}$/.test(expires)) return false;
    if (Number(expires) * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(key, expires), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private sign(key: string, expires: string): string {
    return createHmac('sha256', this.signingKey)
      .update(`${key}\n${expires}`)
      .digest('hex');
  }
}
