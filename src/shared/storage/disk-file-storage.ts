import { promises as fs } from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileStoragePort } from './file-storage.port';

@Injectable()
export class DiskFileStorage implements FileStoragePort {
  constructor(private readonly config: ConfigService) {}

  private root(): string {
    return this.config.get<string>('STORAGE_DIR') ?? './storage';
  }

  private publicBase(): string {
    return (
      this.config.get<string>('FILES_PUBLIC_BASE_URL') ??
      'http://localhost:3000/api/v1/files'
    );
  }

  async save(
    namespace: string,
    filename: string,
    bytes: Buffer,
    _contentType: string,
  ): Promise<{ url: string }> {
    const dir = path.join(this.root(), namespace);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), bytes);
    return { url: `${this.publicBase()}/${namespace}/${filename}` };
  }

  async delete(namespace: string, filename: string): Promise<void> {
    // force: true → no lanza si el archivo no existe (idempotente).
    await fs.rm(path.join(this.root(), namespace, filename), { force: true });
  }
}
