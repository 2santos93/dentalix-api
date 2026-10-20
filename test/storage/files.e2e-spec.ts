import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigModule } from '../../src/config/config.module';
import { applySecurity } from '../../src/shared/security/apply-security';
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
    // Helmet como en main.ts: los casos de DX-151 comprueban que /files/signed
    // (y solo esa ruta) relaja X-Frame-Options y frame-ancestors.
    applySecurity(app);
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
    for (const name of [
      'dx151-e2e.bin',
      'dx151.heic',
      'dx151.docx',
      'dx151.dcm',
    ]) {
      await fs.rm(path.join(root, 'clinical', name), { force: true });
    }
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

  it('400s a name the storage would reject as a key (".." inside), not a 500', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/files/avatars/a..png')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/files/avatars/.env')
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

    it('los avatares siguen sin poder incrustarse en otro origen (DX-151)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/files/avatars/sample.png')
        .expect(200);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'self'",
      );
    });

    it('con disposición y nombre: los responde, enmarcable y en sandbox (DX-151)', async () => {
      const url = await storage.getSignedUrl(key, 60, {
        disposition: 'attachment',
        filename: 'radio ñ.pdf',
      });
      const res = await request(app.getHttpServer())
        .get(pathOf(url))
        .expect(200);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="radio n.pdf"; filename*=UTF-8''radio%20%C3%B1.pdf`,
      );
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.headers['content-security-policy']).toBe(
        'frame-ancestors *; sandbox',
      );
      expect((res.body as Buffer).toString()).toBe('%PDF-1.7');
    });

    it('el tipo pedido manda sobre la extensión (DX-151)', async () => {
      const binKey = 'clinical/dx151-e2e.bin';
      await storage.save(binKey, Buffer.from('%PDF-1.7'), 'application/pdf');
      const url = await storage.getSignedUrl(binKey, 60, {
        disposition: 'inline',
        contentType: 'application/pdf',
      });
      const res = await request(app.getHttpServer())
        .get(pathOf(url))
        .expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline');
    });

    it('403 si se manipula la disposición, el nombre o el tipo firmados (DX-151)', async () => {
      const url = new URL(
        await storage.getSignedUrl(key, 60, {
          disposition: 'inline',
          filename: 'radio.pdf',
        }),
      );
      const changes: Array<[string, string | null]> = [
        ['disposition', 'attachment'],
        ['filename', 'otro.pdf'],
        ['type', 'text/html'],
        ['type', ''],
        ['disposition', null],
      ];
      for (const [param, value] of changes) {
        const tampered = new URL(url);
        if (value === null) tampered.searchParams.delete(param);
        else tampered.searchParams.set(param, value);
        await request(app.getHttpServer())
          .get(pathOf(tampered.toString()))
          .expect(403);
      }
    });

    it.each([
      ['clinical/dx151.heic', 'image/heic'],
      [
        'clinical/dx151.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      ['clinical/dx151.dcm', 'application/dicom'],
    ])('%s se sirve como %s (DX-151)', async (fileKey, type) => {
      await storage.save(fileKey, Buffer.from('DATA'), type);
      const url = await storage.getSignedUrl(fileKey, 60);
      const res = await request(app.getHttpServer())
        .get(pathOf(url))
        .expect(200);
      expect(res.headers['content-type']).toContain(type);
    });

    it('404 si la firma vale pero el fichero ya no existe', async () => {
      const url = await storage.getSignedUrl('clinical/no-existe.pdf', 60);
      await request(app.getHttpServer()).get(pathOf(url)).expect(404);
    });
  });
});
