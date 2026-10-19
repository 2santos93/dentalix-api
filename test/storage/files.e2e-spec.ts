import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigModule } from '../../src/config/config.module';
import { StorageModule } from '../../src/shared/storage/storage.module';
import {
  FILE_STORAGE,
  FileStoragePort,
} from '../../src/shared/storage/file-storage.port';

describe('Files (e2e)', () => {
  let app: INestApplication<App>;
  let storage: FileStoragePort;
  const root = process.env.STORAGE_DIR ?? './storage-test';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, StorageModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    storage = app.get<FileStoragePort>(FILE_STORAGE);
    await fs.mkdir(path.join(root, 'avatars'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'avatars', 'sample.png'),
      Buffer.from('PNGDATA'),
    );
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(path.join(root, 'avatars', 'sample.png'), { force: true });
    await fs.rm(path.join(root, 'clinical', 'dx084-e2e.pdf'), { force: true });
  });

  it('serves an existing avatar with an image content-type', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/files/avatars/sample.png')
      .expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect((res.body as Buffer).toString()).toBe('PNGDATA');
  });

  it('404s a missing avatar', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/files/avatars/nope.png')
      .expect(404);
  });

  it('400s an invalid filename (path traversal)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/files/avatars/..%2f..%2fsecret')
      .expect(400);
  });

  // DX-084: con el disco (solo desarrollo), las URL firmadas las sirve la API
  // en /files/signed; con S3 van directas al bucket.
  describe('URL firmada (disco)', () => {
    const key = 'clinical/dx084-e2e.pdf';
    beforeAll(async () => {
      await storage.save(key, Buffer.from('%PDF-1.7'), 'application/pdf');
    });

    function pathOf(url: string): string {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    }

    it('sirve el fichero con una firma vigente, sin caché compartida', async () => {
      const url = await storage.getSignedUrl(key, 60);
      const res = await request(app.getHttpServer())
        .get(pathOf(url))
        .expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect((res.body as Buffer).toString()).toBe('%PDF-1.7');
    });

    it('403 con la firma manipulada, de otra clave o caducada', async () => {
      const url = new URL(await storage.getSignedUrl(key, 60));
      const tampered = new URL(url);
      tampered.searchParams.set('key', 'avatars/sample.png');
      await request(app.getHttpServer())
        .get(pathOf(tampered.toString()))
        .expect(403);
      const expired = new URL(url);
      expired.searchParams.set('expires', '1000');
      await request(app.getHttpServer())
        .get(pathOf(expired.toString()))
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/v1/files/signed?key=clinical%2Fdx084-e2e.pdf')
        .expect(403);
    });

    it('caduca de verdad al pasar el TTL', async () => {
      const url = await storage.getSignedUrl(key, 1);
      await request(app.getHttpServer()).get(pathOf(url)).expect(200);
      await new Promise((r) => setTimeout(r, 2100));
      await request(app.getHttpServer()).get(pathOf(url)).expect(403);
    });

    it('404 si la firma vale pero el fichero ya no existe', async () => {
      const url = await storage.getSignedUrl('clinical/no-existe.pdf', 60);
      await request(app.getHttpServer()).get(pathOf(url)).expect(404);
    });
  });
});
