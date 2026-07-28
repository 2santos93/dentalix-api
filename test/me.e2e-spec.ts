import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

const raw = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

interface Tokens { accessToken: string; refreshToken: string }
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    await raw.clinicMembership.deleteMany({ where: { tenant: { subdomain: sub } } });
    await raw.user.deleteMany({ where: { email: 'perfil@e2e.com' } });
    await raw.tenant.deleteMany({ where: { subdomain: sub } });

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Perfil E2E', subdomain: sub, email: 'perfil@e2e.com', password: 'OldPass1!', fullName: 'Nombre Viejo' })
      .expect(201);
  });

  afterAll(async () => {
    await raw.clinicMembership.deleteMany({ where: { tenant: { subdomain: sub } } });
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
    expect(body.memberships[0]).toMatchObject({ clinicName: 'Perfil E2E', role: 'OWNER' });
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
      .expect(204);
    await login('NewPass2!'); // 201 or throws
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

    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((me.body as Profile).avatarUrl).toBe(avatarUrl);

    // El path servible es lo que va después de FILES_PUBLIC_BASE_URL.
    const name = avatarUrl.split('/files/avatars/')[1];
    await request(app.getHttpServer())
      .get(`/api/v1/files/avatars/${name}`)
      .expect(200);
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
