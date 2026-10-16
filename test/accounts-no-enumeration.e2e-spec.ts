import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { INVITATION_LIMITS } from '../src/modules/invitations/application/use-cases/create-invitation.use-case';
import { PasswordService } from '../src/shared/crypto/password.service';

// DX-029 (SEC-006/SEC-007): ningún endpoint público ni de ADMIN deja saber si
// un email arbitrario tiene cuenta, el token de la invitación solo viaja por
// email, una cuenta sin verificar se puede reclamar desde ese enlace y una
// clínica no puede invitar sin límite.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwords = new PasswordService();

const DOMAIN = '@dx029.test';
const SUB_A = 'dx029-a';
const SUB_LIMIT = 'dx029-limite';
const PASSWORD = 'Clave-Dx029-2026!';
const DAILY_LIMIT = 3;

async function cleanup(): Promise<void> {
  const subs = [
    SUB_A,
    SUB_LIMIT,
    'dx029-nueva',
    'dx029-existente',
    'dx029-squat',
  ];
  await raw.clinicInvitation.deleteMany({
    where: { tenant: { subdomain: { in: subs } } },
  });
  await raw.clinicMembership.deleteMany({
    where: { tenant: { subdomain: { in: subs } } },
  });
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await raw.pendingRegistration.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await raw.tenant.deleteMany({ where: { subdomain: { in: subs } } });
}

describe('Cuentas sin enumeración (e2e, DX-029)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let adminA: string;

  const http = () => request(app.getHttpServer());
  const login = (sub: string, email: string, password: string) =>
    http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email, password });
  const invite = (sub: string, token: string, email: string) =>
    http()
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Persona Invitada', email, role: ClinicRole.DENTIST });

  beforeAll(async () => {
    await cleanup();
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder
          .overrideProvider(INVITATION_LIMITS)
          .useValue({ tenantDaily: DAILY_LIMIT });
      },
    });
    await registerVerified(app, {
      clinicName: 'Clínica DX-029',
      subdomain: SUB_A,
      email: `owner-a${DOMAIN}`,
      password: PASSWORD,
      fullName: 'Dra. Dueña',
    });
    const res = await login(SUB_A, `owner-a${DOMAIN}`, PASSWORD).expect(201);
    adminA = (res.body as { accessToken: string }).accessToken;
    mailer.clear();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  describe('POST /auth/register', () => {
    const payload = (email: string, subdomain: string) => ({
      clinicName: 'Clínica Sonda',
      subdomain,
      email,
      password: 'Otra-Clave-2026!',
      fullName: 'Quien Sea',
    });

    it('email existente y email nuevo reciben EXACTAMENTE la misma respuesta', async () => {
      const existing = await http()
        .post('/api/v1/auth/register')
        .send(payload(`OWNER-A${DOMAIN}`, 'dx029-existente'));
      const fresh = await http()
        .post('/api/v1/auth/register')
        .send(payload(`nueva${DOMAIN}`, 'dx029-nueva'));

      expect(existing.status).toBe(202);
      expect(fresh.status).toBe(existing.status);
      expect(fresh.body).toEqual(existing.body);
      expect(Object.keys(existing.body as object)).toEqual(['message']);

      // Ninguno crea la clínica (ni reserva el subdominio) todavía.
      expect(
        await raw.tenant.count({
          where: { subdomain: { in: ['dx029-existente', 'dx029-nueva'] } },
        }),
      ).toBe(0);
    });

    it('al titular del email existente le llega un AVISO (sin enlace de verificación)', async () => {
      const notice = await mailer.waitFor(
        `owner-a${DOMAIN}`,
        /Alguien intentó registrar una clínica/,
      );
      expect(notice).toBeTruthy();
      const toOwner = mailer.sent.filter((m) => m.to === `owner-a${DOMAIN}`);
      expect(toOwner.some((m) => /register\/verificar/.test(m.text))).toBe(
        false,
      );
      // Y su cuenta no cambió: sigue entrando con su contraseña.
      await login(SUB_A, `owner-a${DOMAIN}`, PASSWORD).expect(201);
      expect(
        await raw.pendingRegistration.count({
          where: { email: `owner-a${DOMAIN}` },
        }),
      ).toBe(0);
    });

    it('el email nuevo recibe el enlace; al abrirlo nace la clínica con el email verificado', async () => {
      const [, token] = await mailer.waitFor(
        `nueva${DOMAIN}`,
        /\/register\/verificar\/([A-Za-z0-9_-]{43})/,
      );
      // En la BD solo el hash, nunca el token.
      const row = await raw.pendingRegistration.findUniqueOrThrow({
        where: { email: `nueva${DOMAIN}` },
      });
      expect(row.tokenHash).not.toContain(token);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);

      const verified = await http()
        .post('/api/v1/auth/register/verify')
        .send({ token })
        .expect(201);
      expect(verified.body).toMatchObject({ subdomain: 'dx029-nueva' });
      const user = await raw.user.findFirstOrThrow({
        where: { email: `nueva${DOMAIN}` },
      });
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      await login('dx029-nueva', `nueva${DOMAIN}`, 'Otra-Clave-2026!').expect(
        201,
      );

      // Un solo uso.
      const again = await http()
        .post('/api/v1/auth/register/verify')
        .send({ token })
        .expect(404);
      expect((again.body as { message: string }).message).toMatch(
        /no es válido/,
      );
    });
  });

  describe('invitaciones', () => {
    it('crear una invitación responde igual para un email con cuenta y sin ella, y nunca trae el token', async () => {
      await raw.user.create({
        data: {
          email: `con-cuenta${DOMAIN}`,
          passwordHash: await passwords.hash(PASSWORD),
          fullName: 'Con Cuenta',
          emailVerifiedAt: new Date(),
        },
      });
      const withAccount = await invite(SUB_A, adminA, `con-cuenta${DOMAIN}`);
      const without = await invite(SUB_A, adminA, `sin-cuenta${DOMAIN}`);

      expect(withAccount.status).toBe(201);
      expect(without.status).toBe(withAccount.status);
      expect(Object.keys(without.body as object).sort()).toEqual(
        Object.keys(withAccount.body as object).sort(),
      );
      expect(withAccount.body).not.toHaveProperty('token');
      expect(without.body).not.toHaveProperty('token');
    });

    it('GET público con un token inventado no dice nada de ningún email', async () => {
      const res = await http()
        .get(`/api/v1/public/invitations/${'f'.repeat(64)}`)
        .set('X-Tenant-Host', hostFor(SUB_A))
        .expect(200);
      expect(res.body).toEqual({ status: 'NOT_FOUND' });
    });

    it('aceptar sin token válido responde igual exista o no la cuenta', async () => {
      const bad = (password: string) =>
        http()
          .post(`/api/v1/public/invitations/${'e'.repeat(64)}/accept`)
          .set('X-Tenant-Host', hostFor(SUB_A))
          .send({ password });
      const a = await bad(PASSWORD);
      const b = await bad('Otra-Distinta-1!');
      expect(a.status).toBe(404);
      expect(b.status).toBe(a.status);
      expect(b.body).toEqual(a.body);
    });

    it('cuenta sin verificar (pre-secuestro): el enlace del correo la reclama, invalida sesiones previas y audita', async () => {
      // El «atacante» creó la cuenta de la doctora sin controlar su email
      // (como permitía el sistema antes de DX-029) y tiene sesión abierta.
      const victim = `dra.victima${DOMAIN}`;
      await registerVerified(app, {
        clinicName: 'Clínica Atacante',
        subdomain: 'dx029-squat',
        email: victim,
        password: 'Clave-Del-Atacante-1!',
        fullName: 'Dra. Víctima',
      });
      await raw.user.update({
        where: { email: victim },
        data: { emailVerifiedAt: null },
      });
      const attackerSession = await login(
        'dx029-squat',
        victim,
        'Clave-Del-Atacante-1!',
      ).expect(201);
      const attackerRefresh = (attackerSession.body as { refreshToken: string })
        .refreshToken;

      // Una clínica legítima la invita: el enlace llega a SU buzón.
      mailer.clear();
      await invite(SUB_A, adminA, victim).expect(201);
      const token = await mailer.invitationToken(victim);
      const view = await http()
        .get(`/api/v1/public/invitations/${token}`)
        .set('X-Tenant-Host', hostFor(SUB_A))
        .expect(200);
      expect(view.body).toMatchObject({ requiresCurrentPassword: false });

      await http()
        .post(`/api/v1/public/invitations/${token}/accept`)
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ password: 'Clave-De-La-Doctora-1!' })
        .expect(201);

      const user = await raw.user.findUniqueOrThrow({
        where: { email: victim },
      });
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      // Las credenciales y sesiones del atacante ya no sirven.
      await login('dx029-squat', victim, 'Clave-Del-Atacante-1!').expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: attackerRefresh })
        .expect(401);
      await login(SUB_A, victim, 'Clave-De-La-Doctora-1!').expect(201);

      const audit = await raw.auditEvent.findFirst({
        where: {
          actorUserId: user.id,
          action: 'PASSWORD_RESET',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit?.metadata).toEqual({ reason: 'INVITATION_ACCOUNT_CLAIM' });
    });

    it(`límite diario por clínica: la invitación ${DAILY_LIMIT + 1} -> 429 en español`, async () => {
      await registerVerified(app, {
        clinicName: 'Clínica Límite',
        subdomain: SUB_LIMIT,
        email: `owner-limite${DOMAIN}`,
        password: PASSWORD,
        fullName: 'Dr. Límite',
      });
      const res = await login(SUB_LIMIT, `owner-limite${DOMAIN}`, PASSWORD);
      const admin = (res.body as { accessToken: string }).accessToken;
      for (let i = 0; i < DAILY_LIMIT; i++) {
        await invite(SUB_LIMIT, admin, `limite${i}${DOMAIN}`).expect(201);
      }
      const blocked = await invite(SUB_LIMIT, admin, `limite-extra${DOMAIN}`);
      expect(blocked.status).toBe(429);
      expect((blocked.body as { message: string }).message).toBe(
        `La clínica alcanzó el máximo de ${DAILY_LIMIT} invitaciones en 24 horas. Vuelve a intentarlo mañana o escribe a soporte si necesitas más.`,
      );
    });
  });
});
