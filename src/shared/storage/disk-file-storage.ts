import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import { contentTypeOf } from './content-type';
import { assertFileKey, isFileKey, publicFileUrl } from './file-key';
import {
  DirectUploadPolicy,
  DirectUploadTarget,
  FileStoragePort,
  SignedUrlOptions,
  StoredFile,
  StoredFileStream,
  StoredObjectInfo,
  assertSignedUrlOptions,
  assertSignedUrlTtl,
} from './file-storage.port';
import type { DiskStorageConfig } from './storage-config';
import { hashLocalFile, readLocalRange } from './local-file';
import { StorageObjectChangedError } from './storage-errors';
import { StorageOp, StorageOpLogger, StorageOutcome } from './storage-op-log';

/** Subida directa ya verificada (firma y caducidad) por `verifyDirectUpload`. */
export interface VerifiedDirectUpload {
  key: string;
  maxBytes: number;
  sha256Base64: string;
  metadata: Record<string, string>;
}

/** Resultado de `acceptDirectUpload`: lo que S3 respondería con un 4xx. */
export type DirectUploadOutcome =
  'ok' | 'empty' | 'too_large' | 'checksum_mismatch';

/** Lo que el disco guarda junto a un objeto subido directamente. */
interface SidecarMeta {
  sha256Base64: string | null;
  metadata: Record<string, string>;
}

function classifyDiskError(err: unknown): StorageOutcome {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'not_found';
  if (err instanceof StorageObjectChangedError) return 'precondition_failed';
  return 'error';
}

const isMissing = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Adaptador de DISCO del `FileStoragePort`: solo desarrollo y tests
 * (`validateEnv` lo prohíbe en producción, DX-084). Guarda en
 * `STORAGE_DIR/<clave>`.
 *
 * Las URL firmadas apuntan a `FILES_PUBLIC_BASE_URL/signed` (FilesController)
 * con un HMAC de la clave, la caducidad y, si las hay, la disposición, el
 * nombre y el tipo (DX-151). La clave del HMAC es aleatoria por
 * proceso: un reinicio invalida las URL emitidas, lo que en local da igual (y
 * el disco no se comparte entre réplicas de todos modos).
 *
 * DX-259: la subida directa imita el POST prefirmado de S3 con
 * `FILES_PUBLIC_BASE_URL/uploads` (FilesController): mismos campos firmados
 * con el HMAC, tope de tamaño y SHA-256 obligatorio. El checksum y los
 * metadatos del objeto van en `STORAGE_DIR/.meta/<clave>.json` (`.meta` no
 * puede ser el primer segmento de una clave).
 */
export class DiskFileStorage implements FileStoragePort {
  private readonly signingKey = randomBytes(32);

  constructor(
    private readonly cfg: DiskStorageConfig,
    private readonly ops: StorageOpLogger = new StorageOpLogger(),
  ) {}

  private pathOf(key: string): string {
    assertFileKey(key);
    return path.join(this.cfg.root, ...key.split('/'));
  }

  private metaPathOf(key: string): string {
    assertFileKey(key);
    return `${path.join(this.cfg.root, '.meta', ...key.split('/'))}.json`;
  }

  private time<T>(
    op: StorageOp,
    fn: () => Promise<T>,
    bytes?: (result: T) => number | undefined,
  ): Promise<T> {
    return this.ops.time('disk', op, fn, classifyDiskError, bytes);
  }

  async save(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const file = this.pathOf(key);
    await this.time(
      'put',
      async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
      },
      () => bytes.length,
    );
  }

  async saveFile(
    key: string,
    filePath: string,
    _contentType: string,
  ): Promise<void> {
    const file = this.pathOf(key);
    await this.time(
      'put',
      async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.copyFile(filePath, file);
        return (await fs.stat(file)).size;
      },
      (size) => size,
    );
  }

  async read(key: string): Promise<StoredFile | null> {
    const file = this.pathOf(key);
    try {
      return await this.time(
        'get',
        async () => ({
          bytes: await fs.readFile(file),
          contentType: contentTypeOf(key),
        }),
        (stored) => stored.bytes.length,
      );
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async openRead(key: string): Promise<StoredFileStream | null> {
    const file = this.pathOf(key);
    try {
      return await this.time('get', async () => {
        const stats = await fs.stat(file);
        return {
          stream: createReadStream(file),
          size: stats.size,
          etag: this.etagOf(stats),
        };
      });
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  private etagOf(stats: { size: number; mtimeMs: number }): string {
    return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    const file = this.pathOf(key);
    try {
      return await this.time('head', async () => {
        const stats = await fs.stat(file);
        const meta = await this.readMeta(key);
        return {
          size: stats.size,
          sha256Base64: meta?.sha256Base64 ?? null,
          etag: this.etagOf(stats),
          metadata: meta?.metadata ?? {},
        };
      });
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  private async readMeta(key: string): Promise<SidecarMeta | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.metaPathOf(key), 'utf8'),
      ) as SidecarMeta;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  private async assertVersion(file: string, etag: string): Promise<void> {
    let current: string;
    try {
      current = this.etagOf(await fs.stat(file));
    } catch (err) {
      if (isMissing(err)) throw new StorageObjectChangedError();
      throw err;
    }
    if (current !== etag) throw new StorageObjectChangedError();
  }

  async readRange(
    key: string,
    start: number,
    end: number,
    etag: string,
  ): Promise<Buffer> {
    const file = this.pathOf(key);
    if (end <= start) return Buffer.alloc(0);
    return this.time(
      'range',
      async () => {
        await this.assertVersion(file, etag);
        return readLocalRange(file, start, end);
      },
      (bytes) => bytes.length,
    );
  }

  async copyVersion(
    from: string,
    to: string,
    _contentType: string,
    etag: string,
  ): Promise<void> {
    const source = this.pathOf(from);
    const target = this.pathOf(to);
    await this.time('copy', async () => {
      await this.assertVersion(source, etag);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Copia a un temporal y renombra: `to` nunca se ve a medias.
      const partial = `${target}.${process.pid}.${Date.now()}.partial`;
      await fs.copyFile(source, partial);
      await fs.rename(partial, target);
    });
  }

  createDirectUpload(
    key: string,
    policy: DirectUploadPolicy,
  ): Promise<DirectUploadTarget> {
    return Promise.resolve().then(() => {
      assertFileKey(key);
      const expiresAt = new Date(Date.now() + policy.ttlSeconds * 1000);
      const fields = {
        key,
        expires: String(Math.floor(expiresAt.getTime() / 1000)),
        max: String(policy.maxBytes),
        sha256: policy.sha256Base64,
        meta: JSON.stringify(policy.metadata),
      };
      return {
        method: 'POST' as const,
        url: publicFileUrl(this.cfg.publicBaseUrl, 'uploads'),
        fields: { ...fields, signature: this.signUpload(fields) },
        expiresAt,
      };
    });
  }

  private signUpload(fields: Record<string, string>): string {
    const payload = JSON.stringify([
      'upload',
      fields.key,
      fields.expires,
      fields.max,
      fields.sha256,
      fields.meta,
    ]);
    return createHmac('sha256', this.signingKey).update(payload).digest('hex');
  }

  /**
   * Los campos de un POST a `/files/uploads`, si los firmó este proceso y no
   * han caducado; null si no (la ruta responde 403, como S3).
   */
  verifyDirectUpload(
    fields: Record<string, unknown>,
  ): VerifiedDirectUpload | null {
    const get = (name: string): string | null =>
      typeof fields[name] === 'string' ? fields[name] : null;
    const [key, expires, max, sha256, meta, signature] = [
      'key',
      'expires',
      'max',
      'sha256',
      'meta',
      'signature',
    ].map(get);
    if (!key || !expires || !max || !sha256 || !meta || !signature) {
      return null;
    }
    if (
      !isFileKey(key) ||
      !/^\d{1,12}$/.test(expires) ||
      !/^\d{1,9}$/.test(max)
    ) {
      return null;
    }
    if (Number(expires) * 1000 < Date.now()) return null;
    const expected = Buffer.from(
      this.signUpload({ key, expires, max, sha256, meta }),
      'hex',
    );
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    return {
      key,
      maxBytes: Number(max),
      sha256Base64: sha256,
      metadata: JSON.parse(meta) as Record<string, string>,
    };
  }

  /**
   * Guarda bajo su clave el temporal de una subida directa ya verificada si
   * cumple el tamaño y el SHA-256 firmados; si no, no guarda nada.
   */
  async acceptDirectUpload(
    upload: VerifiedDirectUpload,
    tempFile: string,
  ): Promise<DirectUploadOutcome> {
    const target = this.pathOf(upload.key);
    return this.time('put', async (): Promise<DirectUploadOutcome> => {
      const { sha256, size } = await hashLocalFile(tempFile);
      const sha256Base64 = sha256.toString('base64');
      if (size === 0) return 'empty';
      if (size > upload.maxBytes) return 'too_large';
      if (sha256Base64 !== upload.sha256Base64) return 'checksum_mismatch';
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(tempFile, target);
      const metaFile = this.metaPathOf(upload.key);
      await fs.mkdir(path.dirname(metaFile), { recursive: true });
      const meta: SidecarMeta = {
        sha256Base64,
        metadata: upload.metadata,
      };
      await fs.writeFile(metaFile, JSON.stringify(meta));
      return 'ok';
    });
  }

  async checkReachable(): Promise<void> {
    await this.time('head-bucket', async () => {
      await fs.mkdir(this.cfg.root, { recursive: true });
      await fs.access(this.cfg.root, fs.constants.W_OK);
    });
  }

  async delete(key: string): Promise<void> {
    // force: true → no lanza si el archivo no existe (idempotente).
    const file = this.pathOf(key);
    await this.time('delete', async () => {
      await fs.rm(file, { force: true });
      await fs.rm(this.metaPathOf(key), { force: true });
    });
  }

  publicUrl(key: string): string {
    assertFileKey(key);
    return publicFileUrl(this.cfg.publicBaseUrl, key);
  }

  getSignedUrl(
    key: string,
    ttlSeconds: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    // Dentro de la promesa: una clave o un TTL inválidos rechazan, no lanzan.
    return Promise.resolve().then(() => {
      assertFileKey(key);
      assertSignedUrlTtl(ttlSeconds);
      assertSignedUrlOptions(options);
      const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
      // Nombre o tipo vacíos no viajan en la URL, así que tampoco se firman.
      const signed: SignedUrlOptions | undefined = options && {
        disposition: options.disposition,
        ...(options.filename ? { filename: options.filename } : {}),
        ...(options.contentType ? { contentType: options.contentType } : {}),
      };
      const query = new URLSearchParams({ key, expires });
      if (signed) query.set('disposition', signed.disposition);
      if (signed?.filename) query.set('filename', signed.filename);
      if (signed?.contentType) query.set('type', signed.contentType);
      query.set('signature', this.sign(key, expires, signed));
      return `${publicFileUrl(this.cfg.publicBaseUrl, 'signed')}?${query.toString()}`;
    });
  }

  /**
   * true si la firma es de este proceso, para esa clave y esas opciones
   * (disposición, nombre, tipo), y no ha caducado.
   */
  verifySignedUrl(
    key: string,
    expires: string,
    signature: string,
    options?: SignedUrlOptions,
  ): boolean {
    if (!isFileKey(key) || !/^\d{1,12}$/.test(expires)) return false;
    if (Number(expires) * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(key, expires, options), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private sign(
    key: string,
    expires: string,
    options?: SignedUrlOptions,
  ): string {
    // JSON y no `a\nb\n…`: un nombre con saltos de línea no puede desplazar
    // un campo a otro (p. ej. colar un `type` dentro del `filename`).
    const payload = JSON.stringify([
      key,
      expires,
      options?.disposition ?? null,
      options?.filename ?? null,
      options?.contentType ?? null,
    ]);
    return createHmac('sha256', this.signingKey).update(payload).digest('hex');
  }
}
