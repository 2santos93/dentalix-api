import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../src/shared/storage/file-storage.port';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Tokens {
  accessToken: string;
  refreshToken: string;
}
interface Profile {
  fullName: string;
  email: string;
  avatarUrl: string | null;
  memberships: { tenantId: string; clinicName: string; role: string }[];
}

describe('Me (e2e)', () => {
  let app: INestApplication<App>;
  const sub = 'perfil-e2e';

  async function login(password: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email: 'perfil@e2e.com', password })
      .expect(201);
    return (res.body as Tokens).accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');

    await raw.clinicMembership.deleteMany({
      where: { tenant: { subdomain: sub } },
    });
    await raw.user.deleteMany({ where: { email: 'perfil@e2e.com' } });
    await raw.tenant.deleteMany({ where: { subdomain: sub } });

    await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Perfil E2E',
        subdomain: sub,
        email: 'perfil@e2e.com',
        password: 'OldPass1!',
        fullName: 'Nombre Viejo',
      }),
    );
  });

  afterAll(async () => {
    await raw.clinicMembership.deleteMany({
      where: { tenant: { subdomain: sub } },
    });
    await raw.user.deleteMany({ where: { email: 'perfil@e2e.com' } });
    await raw.tenant.deleteMany({ where: { subdomain: sub } });
    await app.close();
    await raw.$disconnect();
  });

  it('GET /me returns the profile with the current clinic + role', async () => {
    const token = await login('OldPass1!');
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as Profile;
    expect(body.fullName).toBe('Nombre Viejo');
    expect(body.email).toBe('perfil@e2e.com');
    expect(body.avatarUrl).toBeNull();
    expect(body.memberships[0]).toMatchObject({
      clinicName: 'Perfil E2E',
      role: 'ADMIN',
    });
  });

  it('PATCH /me updates the name', async () => {
    const token = await login('OldPass1!');
    const res = await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Nombre Nuevo' })
      .expect(200);
    expect((res.body as Profile).fullName).toBe('Nombre Nuevo');
  });

  it('rejects a change-password with the wrong current password (401)', async () => {
    const token = await login('OldPass1!');
    await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WRONG', newPassword: 'NewPass2!' })
      .expect(401);
  });

  it('changes the password and lets the user log in with the new one', async () => {
    const token = await login('OldPass1!');
    await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'OldPass1!', newPassword: 'NewPass2!' })
      .expect(200);
    await login('NewPass2!'); // 201 or throws
  });

  it('DX-084: rejects (400) a file that is not really the declared image type', async () => {
    const token = await login('NewPass2!');
    await request(app.getHttpServer())
      .post('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .expect(400);
    const stored = await raw.user.findFirstOrThrow({
      where: { email: 'perfil@e2e.com' },
      select: { avatarKey: true },
    });
    expect(stored.avatarKey).toBeNull();
  });

  it('uploads an avatar, exposes it on GET /me and serves the file', async () => {
    const token = await login('NewPass2!');
    const png = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes
    const up = await request(app.getHttpServer())
      .post('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    const avatarUrl = (up.body as { avatarUrl: string }).avatarUrl;
    expect(avatarUrl).toContain('/files/avatars/');
    // DX-084: en la BD solo la clave; la URL se calcula al responder.
    const stored = await raw.user.findFirstOrThrow({
      where: { email: 'perfil@e2e.com' },
      select: { id: true, avatarKey: true },
    });
    // DX-259: con la versión del contenido en la clave (`-<16 hex>`).
    expect(stored.avatarKey).toMatch(
      new RegExp(`^avatars/${stored.id}-[0-9a-f]{16}\\.png$`),
    );
    expect(avatarUrl).toBe(
      `${process.env.FILES_PUBLIC_BASE_URL}/${stored.avatarKey}`,
    );

    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((me.body as Profile).avatarUrl).toBe(avatarUrl);

    // El path servible es lo que va después de FILES_PUBLIC_BASE_URL.
    const name = avatarUrl.split('/files/avatars/')[1];
    const served = await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${name}`)
      .expect(200);
    // DX-259 (OPS-039): versionado → el navegador lo guarda sin revalidar.
    expect(served.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );

    // Cambiar el avatar cambia su URL (otra versión), y el anterior se borra.
    const next = await request(app.getHttpServer())
      .post('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.concat([png, Buffer.from('v2')]), {
        filename: 'b.png',
        contentType: 'image/png',
      })
      .expect(200);
    const nextUrl = (next.body as { avatarUrl: string }).avatarUrl;
    expect(nextUrl).not.toBe(avatarUrl);
    const gone = await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${name}`)
      .expect(404);
    // Revisión I-2: el 404 de un avatar versionado no se cachea un año.
    expect(gone.headers['cache-control']).toBe('no-store');
    const goneRevalidated = await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${name}`)
      .set('If-None-Match', String(served.headers['etag']))
      .expect(404);
    expect(goneRevalidated.headers['cache-control']).toBe('no-store');
    // Y el 304 de uno vigente mantiene su caché immutable.
    const nextName = nextUrl.split('/files/avatars/')[1];
    const fresh = await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${nextName}`)
      .expect(200);
    const notModified = await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${nextName}`)
      .set('If-None-Match', String(fresh.headers['etag']))
      .expect(304);
    expect(notModified.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('DX-084: an existing avatar saved as an absolute URL of another domain is still served', async () => {
    const token = await login('NewPass2!');
    const user = await raw.user.findFirstOrThrow({
      where: { email: 'perfil@e2e.com' },
      select: { id: true },
    });
    // Un avatar de antes de DX-259: clave sin versión, en el almacén.
    await app
      .get<FileStoragePort>(FILE_STORAGE)
      .save(
        `avatars/${user.id}.png`,
        Buffer.from('89504e470d0a1a0a', 'hex'),
        'image/png',
      );
    await raw.user.update({
      where: { id: user.id },
      data: {
        avatarKey: `https://api.dominio-viejo.app/api/v1/files/avatars/${user.id}.png`,
      },
    });
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const avatarUrl = (me.body as Profile).avatarUrl ?? '';
    expect(avatarUrl).toBe(
      `${process.env.FILES_PUBLIC_BASE_URL}/avatars/${user.id}.png`,
    );
    const served = await request(app.getHttpServer())
      .get(new URL(avatarUrl).pathname)
      .expect(200);
    // Sin versión en el nombre: 5 minutos y luego revalida con la ETag.
    expect(served.headers['cache-control']).toBe('public, max-age=300');
    const etag = served.headers['etag'];
    expect(etag).toBeTruthy();
    await request(app.getHttpServer())
      .get(new URL(avatarUrl).pathname)
      .set('If-None-Match', etag)
      .expect(304);
  });

  it('removes the avatar (204) and nulls it on GET /me', async () => {
    const token = await login('NewPass2!');
    await request(app.getHttpServer())
      .delete('/api/v1/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((me.body as Profile).avatarUrl).toBeNull();
  });
});
