import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigModule } from '../../src/config/config.module';
import { StorageModule } from '../../src/shared/storage/storage.module';

describe('Files (e2e)', () => {
  let app: INestApplication<App>;
  const root = process.env.STORAGE_DIR ?? './storage-test';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, StorageModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await fs.mkdir(path.join(root, 'avatars'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'avatars', 'sample.png'),
      Buffer.from('PNGDATA'),
    );
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(path.join(root, 'avatars', 'sample.png'), { force: true });
  });

  it('serves an existing avatar with an image content-type', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/files/avatars/sample.png')
      .expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.toString()).toBe('PNGDATA');
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
});
