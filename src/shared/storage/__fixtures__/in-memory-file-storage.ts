import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { publicFileUrl } from '../file-key';
import { assertSignedUrlOptions } from '../file-storage.port';
import type {
  DirectUploadPolicy,
  DirectUploadTarget,
  FileStoragePort,
  SaveFileOptions,
  SignedUrlOptions,
  StoredFile,
  StoredFileStream,
  StoredObjectInfo,
} from '../file-storage.port';
import { StorageObjectChangedError } from '../storage-errors';

interface MemoryObject extends StoredFile {
  etag: string;
  sha256Base64: string | null;
  metadata: Record<string, string>;
  cacheControl?: string;
}

/** `FileStoragePort` en memoria para los tests de casos de uso. */
export class InMemoryFileStorage implements FileStoragePort {
  readonly files = new Map<string, MemoryObject>();
  readonly saved: string[] = [];
  readonly deleted: string[] = [];
  /** Subidas directas autorizadas: clave → condiciones. */
  readonly directUploads = new Map<string, DirectUploadPolicy>();
  /** Rangos leídos (`[start, end)`), para comprobar que no se lee todo. */
  readonly ranges: [string, number, number][] = [];
  private version = 0;

  constructor(public publicBaseUrl = 'https://api.a.app/api/v1/files') {}

  private put(
    key: string,
    bytes: Buffer,
    contentType: string | null,
    extra: Partial<MemoryObject> = {},
  ): void {
    this.version += 1;
    this.files.set(key, {
      bytes,
      contentType,
      etag: `"v${this.version}"`,
      sha256Base64: null,
      metadata: {},
      ...extra,
    });
  }

  save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.saved.push(key);
    this.put(key, bytes, contentType);
    return Promise.resolve();
  }

  async saveFile(
    key: string,
    filePath: string,
    contentType: string,
    options: SaveFileOptions = {},
  ): Promise<void> {
    this.saved.push(key);
    this.put(key, await readFile(filePath), contentType, {
      cacheControl: options.cacheControl,
    });
  }

  /**
   * Lo que haría el navegador con el POST prefirmado: deja `bytes` en `key`
   * con el SHA-256 que calcula el almacén y los metadatos fijados. Con
   * `sha256Base64: null` imita un proveedor que no guarda el checksum.
   */
  simulateDirectUpload(
    key: string,
    bytes: Buffer,
    overrides: {
      sha256Base64?: string | null;
      metadata?: Record<string, string>;
    } = {},
  ): void {
    const policy = this.directUploads.get(key);
    this.put(key, bytes, 'application/octet-stream', {
      sha256Base64:
        overrides.sha256Base64 !== undefined
          ? overrides.sha256Base64
          : createHash('sha256').update(bytes).digest('base64'),
      metadata: overrides.metadata ?? policy?.metadata ?? {},
    });
  }

  read(key: string): Promise<StoredFile | null> {
    const file = this.files.get(key);
    return Promise.resolve(
      file ? { bytes: file.bytes, contentType: file.contentType } : null,
    );
  }

  openRead(key: string): Promise<StoredFileStream | null> {
    const file = this.files.get(key);
    return Promise.resolve(
      file
        ? {
            stream: Readable.from([file.bytes]),
            size: file.bytes.length,
            etag: file.etag,
          }
        : null,
    );
  }

  stat(key: string): Promise<StoredObjectInfo | null> {
    const file = this.files.get(key);
    return Promise.resolve(
      file
        ? {
            size: file.bytes.length,
            sha256Base64: file.sha256Base64,
            etag: file.etag,
            metadata: file.metadata,
          }
        : null,
    );
  }

  readRange(
    key: string,
    start: number,
    end: number,
    etag: string,
  ): Promise<Buffer> {
    const file = this.files.get(key);
    if (!file || file.etag !== etag) {
      return Promise.reject(new StorageObjectChangedError());
    }
    this.ranges.push([key, start, end]);
    return Promise.resolve(Buffer.from(file.bytes.subarray(start, end)));
  }

  promote(
    from: string,
    to: string,
    contentType: string,
    etag: string,
  ): Promise<void> {
    const file = this.files.get(from);
    if (!file || file.etag !== etag) {
      return Promise.reject(new StorageObjectChangedError());
    }
    this.saved.push(to);
    this.put(to, file.bytes, contentType, {
      sha256Base64: file.sha256Base64,
    });
    // El objeto pendiente ya copiado, en memoria; no una fila.
    // eslint-disable-next-line no-restricted-syntax
    return this.delete(from);
  }

  createDirectUpload(
    key: string,
    policy: DirectUploadPolicy,
  ): Promise<DirectUploadTarget> {
    this.directUploads.set(key, policy);
    return Promise.resolve({
      method: 'POST',
      url: 'memory://bucket',
      fields: { key, 'x-amz-checksum-sha256': policy.sha256Base64 },
      expiresAt: new Date(Date.UTC(2026, 9, 17, 15, 5, 0)),
    });
  }

  checkReachable(): Promise<void> {
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    // Map.delete del almacén en memoria, no una fila de la BD.
    // eslint-disable-next-line no-restricted-syntax
    this.files.delete(key);
    return Promise.resolve();
  }

  publicUrl(key: string): string {
    return publicFileUrl(this.publicBaseUrl, key);
  }

  /**
   * `memory://<clave>?ttl=<n>` y, con opciones, `&disposition=…&filename=…&type=…`
   * (codificados) para que los tests comprueben lo que pidió el caso de uso.
   */
  getSignedUrl(
    key: string,
    ttlSeconds: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    // Como los adaptadores reales: un tipo fuera de la lista blanca rechaza.
    return Promise.resolve().then(() => {
      assertSignedUrlOptions(options);
      const query = new URLSearchParams({ ttl: String(ttlSeconds) });
      if (options) query.set('disposition', options.disposition);
      if (options?.filename) query.set('filename', options.filename);
      if (options?.contentType) query.set('type', options.contentType);
      return `memory://${key}?${query.toString()}`;
    });
  }
}
