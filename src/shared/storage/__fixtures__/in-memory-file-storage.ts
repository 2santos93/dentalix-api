import { publicFileUrl } from '../file-key';
import type { FileStoragePort, StoredFile } from '../file-storage.port';

/** `FileStoragePort` en memoria para los tests de casos de uso. */
export class InMemoryFileStorage implements FileStoragePort {
  readonly files = new Map<string, StoredFile>();
  readonly saved: string[] = [];
  readonly deleted: string[] = [];

  constructor(public publicBaseUrl = 'https://api.a.app/api/v1/files') {}

  save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.saved.push(key);
    this.files.set(key, { bytes, contentType });
    return Promise.resolve();
  }

  read(key: string): Promise<StoredFile | null> {
    return Promise.resolve(this.files.get(key) ?? null);
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

  getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(`memory://${key}?ttl=${ttlSeconds}`);
  }
}
