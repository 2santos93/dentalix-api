import './s3-avatar-env';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { S3FileStorage } from '../../src/shared/storage/s3-file-storage';
import { FILE_STORAGE } from '../../src/shared/storage/file-storage.port';
import { createE2eApp } from '../support/create-e2e-app';
import { describeWithMinio, ensureBucket } from '../support/minio';
import { createS3Client } from '../../src/shared/storage/s3-file-storage';
import { hostFor } from '../support/tenant-host';
import { registerVerified } from '../support/register-verified';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Profile {
  avatarUrl: string | null;
}

// DX-084: avatares con STORAGE_DRIVER=s3 (MinIO) y DOS réplicas de la API
// (dos apps Nest, cada una con su cliente S3) sobre la misma BD y el mismo
// bucket: subir en una, servir en la otra, reemplazar y que el antiguo se
// borre, y un avatar EXISTENTE de antes de DX-084 (URL absoluta en la BD).
describeWithMinio('Avatar con S3 y dos réplicas (e2e)', (cfg) => {
  const sub = 'avatar-s3-e2e';
  const email = 'avatar-s3@e2e.com';
  const password = 'S3Avatar1!';
  let replicaA: INestApplication<App>;
  let replicaB: INestApplication<App>;
  let bucket: S3FileStorage;
  let userId: string;

  async function login(app: INestApplication<App>): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email, password })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function storedKey(): Promise<string | null> {
    const user = await raw.user.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarKey: true },
    });
    return user.avatarKey;
  }

  const pathOf = (url: string): string => new URL(url).pathname;

  async function cleanup(): Promise<void> {
    await raw.clinicMembership.deleteMany({
      where: { tenant: { subdomain: sub } },
    });
    await raw.user.deleteMany({ where: { email } });
    await raw.tenant.deleteMany({ where: { subdomain: sub } });
  }

  beforeAll(async () => {
    await ensureBucket(cfg);
    bucket = new S3FileStorage(createS3Client(cfg), cfg);
    replicaA = await createE2eApp();
    replicaB = await createE2eApp();
    // Las dos réplicas usan el adaptador S3, cada una con su cliente.
    expect(replicaA.get(FILE_STORAGE)).toBeInstanceOf(S3FileStorage);
    expect(replicaA.get(FILE_STORAGE)).not.toBe(replicaB.get(FILE_STORAGE));
    await cleanup();
    const reg = await registerVerified(replicaA, {
      clinicName: 'Avatar S3',
      subdomain: sub,
      email,
      password,
      fullName: 'Ana S3',
    });
    userId = reg.body.userId;
  });

  /** DX-259: clave versionada con los 16 hex del SHA-256 del contenido. */
  const versioned = (bytes: Buffer, ext: string): string =>
    `avatars/${userId}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  const JPG = Buffer.from('ffd8ffe000104a464946', 'hex');

  afterAll(async () => {
    for (const key of [
      versioned(PNG, 'png'),
      versioned(JPG, 'jpg'),
      `avatars/${userId}.webp`,
    ]) {
      await bucket.delete(key);
    }
    await cleanup();
    await replicaA?.close();
    await replicaB?.close();
    await raw.$disconnect();
  });

  it('sube en la réplica A, la BD guarda la clave y la réplica B lo sirve', async () => {
    const token = await login(replicaA);
    const png = PNG;
    const up = await request(replicaA.getHttpServer())
      .post('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    const avatarUrl = (up.body as { avatarUrl: string }).avatarUrl;
    expect(avatarUrl).toBe(
      `${process.env.FILES_PUBLIC_BASE_URL}/${versioned(png, 'png')}`,
    );
    expect(await storedKey()).toBe(versioned(png, 'png'));
    expect((await bucket.read(versioned(png, 'png')))?.bytes).toEqual(png);

    const served = await request(replicaB.getHttpServer())
      .get(pathOf(avatarUrl))
      .expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(served.body as Buffer).toEqual(png);
  });

  it('reemplaza en la réplica B: el antiguo se borra del bucket y A sirve el nuevo', async () => {
    const token = await login(replicaB);
    const jpg = JPG;
    const up = await request(replicaB.getHttpServer())
      .post('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', jpg, { filename: 'b.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const avatarUrl = (up.body as { avatarUrl: string }).avatarUrl;
    expect(await storedKey()).toBe(versioned(jpg, 'jpg'));
    expect(await bucket.read(versioned(PNG, 'png'))).toBeNull();

    await request(replicaA.getHttpServer())
      .get(`/api/v1/files/${versioned(PNG, 'png')}`)
      .expect(404);
    const served = await request(replicaA.getHttpServer())
      .get(pathOf(avatarUrl))
      .expect(200);
    expect(served.body as Buffer).toEqual(jpg);
  });

  it('un avatar existente con URL absoluta de otro dominio sigue funcionando', async () => {
    const webp = Buffer.from('RIFF0000WEBP');
    await bucket.save(`avatars/${userId}.webp`, webp, 'image/webp');
    await raw.user.update({
      where: { id: userId },
      data: {
        avatarKey: `https://api.dominio-viejo.app/api/v1/files/avatars/${userId}.webp`,
      },
    });
    const token = await login(replicaA);
    const me = await request(replicaA.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const avatarUrl = (me.body as Profile).avatarUrl;
    expect(avatarUrl).toBe(
      `${process.env.FILES_PUBLIC_BASE_URL}/avatars/${userId}.webp`,
    );
    const served = await request(replicaB.getHttpServer())
      .get(pathOf(avatarUrl ?? ''))
      .expect(200);
    expect(served.body as Buffer).toEqual(webp);
  });

  it('quitar el avatar borra el objeto y deja la columna en null', async () => {
    const token = await login(replicaB);
    await request(replicaB.getHttpServer())
      .delete('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(await storedKey()).toBeNull();
    expect(await bucket.read(`avatars/${userId}.webp`)).toBeNull();
  });
});
