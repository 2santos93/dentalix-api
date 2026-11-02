import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import {
  registerBody,
  type RegionalFixture,
} from './support/location-fixtures';
import {
  apexPassword,
  enrollmentEmailCode,
  enrollPlatformAdmin,
  totpAt,
} from './support/platform-mfa';
import { registerVerified } from './support/register-verified';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LOGIN_LOCKOUT_CONFIG,
} from '../src/modules/auth/domain/login-lockout';
import { NEW_CLINIC_REQUIRES_ADMIN_MFA } from '../src/modules/auth/domain/user-mfa';
import { mfaKeyHash } from '../src/modules/auth/domain/login-lockout';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import { loadSecuritySettings } from '../src/shared/security/security-settings';
import { PasswordService } from '../src/shared/crypto/password.service';
import { TokenService } from '../src/shared/crypto/token.service';

/**
 * DX-021-bis contra Postgres, con el bloqueo REAL (5 fallos → espera): segundo
 * factor en el apex, códigos de recuperación del superadmin, dispositivo de
 * confianza, política «para todos» con cierre de sesiones, valor por defecto de
 * las clínicas nuevas, reseteo por otro ADMIN y avisos por correo; siempre con
 * aislamiento por clínica y auditoría.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();

const VENEZUELA: RegionalFixture = {
  country: 'VE',
  currency: 'USD',
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h12',
  defaultPhoneRegion: 'VE',
};
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

interface Body {
  accessToken?: string;
  refreshToken?: string;
  mfa?: string;
  mfaToken?: string;
  emailCodeRequired?: boolean;
  code?: string;
  secret?: string;
  recoveryCodes?: string[];
  requireAdminMfa?: boolean;
  requireAllMfa?: boolean;
  recoveryCodesRemaining?: number;
}

describe('Verificación en dos pasos, ampliación (e2e, DX-021-bis)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;

  const http = () => request(app.getHttpServer());
  const login = (host: string, email: string, password = SEEDED_PASSWORD) =>
    http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .send({ email, password });
  const verify = (host: string, body: Record<string, unknown>) =>
    http().post('/api/v1/auth/login/mfa').set('X-Tenant-Host', host).send(body);
  const authed = (
    method: 'get' | 'post' | 'put' | 'delete',
    host: string,
    token: string,
    path: string,
  ) =>
    http()
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
  const refresh = (host: string, refreshToken: string) =>
    http()
      .post('/api/v1/auth/refresh')
      .set('X-Tenant-Host', host)
      .send({ refreshToken });
  const forgetLastStep = (userId: string) =>
    raw.user.update({
      where: { id: userId },
      data: { mfaLastUsedStep: Math.floor(Date.now() / 30_000) - 5 },
    });
  /** Superadmin nuevo, sembrado como los que ya existen al desplegar. */
  const seedSuper = (email: string) =>
    passwordService.hash(SEEDED_PASSWORD).then((passwordHash) =>
      raw.user.create({
        data: {
          email,
          passwordHash,
          fullName: 'Soporte',
          isPlatformAdmin: true,
        },
        select: { id: true, email: true, tokenVersion: true },
      }),
    );
  const outbox = (template: 'MFA_NOTICE' | 'MFA_ENROLLMENT_CODE') =>
    raw.emailOutbox.count({ where: { template } });

  /** Activa el MFA de un miembro desde su perfil. */
  async function enrollMember(host: string, token: string) {
    const start = await authed('post', host, token, '/me/mfa/enrollment')
      .send({ currentPassword: SEEDED_PASSWORD })
      .expect(200);
    const { secret } = start.body as { secret: string };
    const confirm = await authed(
      'post',
      host,
      token,
      '/me/mfa/enrollment/confirm',
    )
      .send({ code: totpAt(secret) })
      .expect(200);
    const body = confirm.body as Body;
    return {
      secret,
      recoveryCodes: body.recoveryCodes!,
      accessToken: body.accessToken!,
    };
  }

  beforeAll(async () => {
    app = await createE2eApp({
      // 1 salto: para poder variar la IP con X-Forwarded-For.
      securitySettings: {
        ...loadSecuritySettings((k) => process.env[k]),
        trustProxyHops: 1,
      },
      override: (builder) => {
        builder
          .overrideProvider(LOGIN_LOCKOUT_CONFIG)
          .useValue(DEFAULT_LOGIN_LOCKOUT);
      },
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-bis', VENEZUELA);
    other = await registerClinic(app, 'clinica-bis-otra', VENEZUELA);
  });

  beforeEach(async () => {
    await raw.loginThrottle.deleteMany({});
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('login del apex', () => {
    it('sin MFA: la contraseña no abre sesión; el token intermedio no da acceso y se envía el código al correo', async () => {
      const user = await seedSuper('alta@platform.test');
      const before = await outbox('MFA_ENROLLMENT_CODE');
      const res = await login('localhost', user.email).expect(201);
      const body = res.body as Body;
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(body).toMatchObject({
        mfa: 'MFA_ENROLLMENT_REQUIRED',
        emailCodeRequired: true,
      });
      expect(await outbox('MFA_ENROLLMENT_CODE')).toBe(before + 1);
      await authed(
        'get',
        'localhost',
        body.mfaToken!,
        '/platform/tenants',
      ).expect(401);
    });

    it('la contraseña sola no enrola: sin código del correo, o con uno malo, no hay secreto', async () => {
      const user = await seedSuper('robada@platform.test');
      const { mfaToken } = await apexPassword(app, user.email);
      const start = (body: Record<string, unknown>) =>
        http()
          .post('/api/v1/auth/login/mfa/enrollment')
          .set('X-Tenant-Host', 'localhost')
          .send({ mfaToken, ...body });
      await start({}).expect(400);
      await start({ emailCode: '00000000' }).expect(400);
      const row = await raw.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { mfaTotpPendingSecretEnc: true },
      });
      expect(row.mfaTotpPendingSecretEnc).toBeNull();
      await http()
        .post('/api/v1/auth/login/mfa/enrollment/confirm')
        .set('X-Tenant-Host', 'localhost')
        .send({ mfaToken, code: '123456' })
        .expect(400);
    });

    it('volver a escribir la contraseña da el mismo código; fallarlo espera solo por cuenta e IP y deja rastro', async () => {
      const user = await seedSuper('reintento@platform.test');
      const first = await apexPassword(app, user.email);
      const second = await apexPassword(app, user.email);
      expect(second.mfaToken).not.toBe(first.mfaToken);
      const emailCode = enrollmentEmailCode(app, user.id, 0);
      const wrong = emailCode === '00000000' ? '11111111' : '00000000';
      const start = (code: string, ip: string) =>
        http()
          .post('/api/v1/auth/login/mfa/enrollment')
          .set('X-Tenant-Host', 'localhost')
          .set('X-Forwarded-For', ip)
          .send({ mfaToken: second.mfaToken, emailCode: code });
      // Un atacante con la contraseña falla a propósito desde su IP…
      for (let i = 0; i < 5; i += 1) {
        await start(wrong, '198.51.100.7').expect(400);
      }
      const locked = await start(emailCode, '198.51.100.7').expect(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      // …y el titular, desde la suya, sigue adelante.
      await start(emailCode, '203.0.113.20').expect(200);

      const events = await raw.platformAuditEvent.count({
        where: {
          actorUserId: user.id,
          action: 'LOGIN_FAILED',
          metadata: { path: ['reason'], equals: 'INVALID_EMAIL_CODE' },
        },
      });
      expect(events).toBe(5);
    });

    it('confirmar sin el código del correo no gasta el contador del titular', async () => {
      const user = await seedSuper('escaneando@platform.test');
      const { mfaToken } = await apexPassword(app, user.email);
      const emailCode = enrollmentEmailCode(app, user.id, 0);
      await http()
        .post('/api/v1/auth/login/mfa/enrollment')
        .set('X-Tenant-Host', 'localhost')
        .send({ mfaToken, emailCode })
        .expect(200);
      const attacker = await apexPassword(app, user.email);
      for (let i = 0; i < 6; i += 1) {
        await http()
          .post('/api/v1/auth/login/mfa/enrollment/confirm')
          .set('X-Tenant-Host', 'localhost')
          .set('X-Forwarded-For', '198.51.100.8')
          .send({ mfaToken: attacker.mfaToken, code: '000000' });
      }
      expect(
        await raw.loginThrottle.count({
          where: { keyHash: mfaKeyHash(user.id) },
        }),
      ).toBe(0);
    });

    it('el código del alta no se pierde: el tope de plataforma no lo frena y no se puede agotar', async () => {
      const user = await seedSuper('sincupo@platform.test');
      const toHash = app
        .get(EmailPayloadCipher, { strict: false })
        .hashRecipient(user.email);
      // El cupo de 3 al día del destinatario, gastado (lo que haría cualquiera).
      await raw.$executeRaw`
        INSERT INTO email_outbox
          (id, "tenantId", template, "toHash", "toMasked", status, attempts,
           "nextAttemptAt", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), NULL, 'registration-notice', ${toHash}, 's***@platform.test',
               'SENT', 1, now(), timezone('utc', now()), timezone('utc', now())
          FROM generate_series(1, 4)`;
      const codes = () =>
        raw.emailOutbox.count({
          where: { toHash, template: 'MFA_ENROLLMENT_CODE' },
        });
      // Diez rondas de contraseña, cada una pasados más de 10 min.
      for (let round = 1; round <= 10; round += 1) {
        await apexPassword(app, user.email);
        expect(await codes()).toBe(round);
        // En el mismo plazo no sale otro: vale el que ya está en el buzón.
        await apexPassword(app, user.email);
        expect(await codes()).toBe(round);
        await raw.$executeRaw`
          UPDATE email_outbox SET "createdAt" = "createdAt" - interval '11 minutes'
           WHERE "toHash" = ${toHash}`;
      }
    });

    it('los correos de seguridad no gastan el cupo del registro público', async () => {
      const user = await seedSuper('cupo@platform.test');
      const outboxService = app.get(EmailOutbox, { strict: false });
      await apexPassword(app, user.email);
      await expect(
        outboxService.withinPlatformRecipientQuota(user.email),
      ).resolves.toBe(true);
    });

    it('DX-021-bis: una sesión de plataforma sin el claim `mfa` no vale ni se renueva', async () => {
      const user = await seedSuper('vieja@platform.test');
      // Lo que emitiría una réplica antigua tras migrar: solo con contraseña.
      const old = await app
        .get(TokenService, { strict: false })
        .issue({ sub: user.id, platform: true, tv: user.tokenVersion });
      await authed(
        'get',
        'localhost',
        old.accessToken,
        '/platform/tenants',
      ).expect(403);
      await refresh('localhost', old.refreshToken).expect(401);
    });

    it('una réplica antigua no puede enrolar a un superadmin: el trigger lo impide', async () => {
      const user = await seedSuper('puerta@platform.test');
      await expect(
        raw.user.update({
          where: { id: user.id },
          data: { mfaTotpPendingSecretEnc: 'v1.secreto-del-atacante' },
        }),
      ).rejects.toThrow(/solo se hace en el login/);
    });

    it('`/me/mfa/enrollment` no es puerta de alta para un superadmin', async () => {
      const member = await seedMember(raw, other, ClinicRole.ADMIN);
      const token = await loginAs(app, other.host, member.email);
      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: true },
      });
      await authed('post', other.host, token, '/me/mfa/enrollment')
        .send({ currentPassword: SEEDED_PASSWORD })
        .expect(403);
      await authed('post', other.host, token, '/me/mfa/enrollment/confirm')
        .send({ code: '123456' })
        .expect(403);
      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: false },
      });
    });

    it('alta completa, entrada con código y refresh de plataforma; código malo auditado', async () => {
      const user = await seedSuper('completa@platform.test');
      const enrolled = await enrollPlatformAdmin(app, user);
      expect(enrolled.recoveryCodes).toHaveLength(10);
      const claims = JSON.parse(
        Buffer.from(enrolled.accessToken.split('.')[1], 'base64url').toString(),
      ) as Record<string, unknown>;
      expect(claims.platform).toBe(true);
      expect(claims.tenantId).toBeUndefined();
      await authed(
        'get',
        'localhost',
        enrolled.accessToken,
        '/platform/tenants',
      ).expect(200);
      await refresh('localhost', enrolled.refreshToken).expect(201);

      const challenge = await apexPassword(app, user.email);
      expect(challenge.mfa).toBe('MFA_REQUIRED');
      expect(challenge.emailCodeRequired).toBeUndefined();
      const bad = await verify('localhost', {
        mfaToken: challenge.mfaToken,
        code: totpAt(enrolled.secret, -4),
      }).expect(401);
      expect((bad.body as Body).code).toBe('MFA_INVALID_CODE');
      const ok = await verify('localhost', {
        mfaToken: challenge.mfaToken,
        code: totpAt(enrolled.secret),
      }).expect(200);
      await authed(
        'get',
        'localhost',
        (ok.body as Body).accessToken!,
        '/platform/tenants',
      ).expect(200);
      // Token de un solo uso.
      await forgetLastStep(user.id);
      const again = await verify('localhost', {
        mfaToken: challenge.mfaToken,
        code: totpAt(enrolled.secret),
      }).expect(401);
      expect((again.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');

      const events = await raw.platformAuditEvent.findMany({
        where: {
          actorUserId: user.id,
          action: { in: ['LOGIN', 'LOGIN_FAILED'] },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { action: true, metadata: true },
      });
      expect(events).toEqual([
        { action: 'LOGIN', metadata: { reason: 'MFA_ENROLLED' } },
        { action: 'LOGIN_FAILED', metadata: { reason: 'INVALID_MFA_CODE' } },
        { action: 'LOGIN', metadata: { reason: 'MFA_TOTP' } },
      ]);
      expect(
        await raw.auditEvent.count({ where: { actorUserId: user.id } }),
      ).toBe(0);
    });

    it('un token del apex no vale en una clínica, ni el de una clínica en el apex', async () => {
      const user = await seedSuper('cruce@platform.test');
      const { secret } = await enrollPlatformAdmin(app, user);
      const { mfaToken } = await apexPassword(app, user.email);
      const cross = await verify(clinic.host, {
        mfaToken,
        code: totpAt(secret),
      }).expect(401);
      expect((cross.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');

      const member = await seedMember(raw, clinic, ClinicRole.DENTIST);
      const token = await loginAs(app, clinic.host, member.email);
      const own = await enrollMember(clinic.host, token);
      const tenantStep = await login(clinic.host, member.email).expect(201);
      const refused = await verify('localhost', {
        mfaToken: (tenantStep.body as Body).mfaToken,
        code: totpAt(own.secret),
      }).expect(401);
      expect((refused.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');
    });

    it('un superadmin nunca se queda con dispositivo de confianza', async () => {
      const user = await seedSuper('confianza@platform.test');
      const { secret } = await enrollPlatformAdmin(app, user);
      const { mfaToken } = await apexPassword(app, user.email);
      const res = await verify('localhost', {
        mfaToken,
        code: totpAt(secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      expect(String(res.headers['set-cookie'])).not.toContain('dentalix_td');
      expect(
        await raw.userTrustedDevice.count({ where: { userId: user.id } }),
      ).toBe(0);
    });

    it('ni entrando por una clínica de la que es miembro', async () => {
      const member = await seedMember(raw, other, ClinicRole.DENTIST);
      const token = await loginAs(app, other.host, member.email);
      const { secret } = await enrollMember(other.host, token);
      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: true },
      });
      await forgetLastStep(member.userId);
      const step = await login(other.host, member.email).expect(201);
      const res = await verify(other.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      expect(String(res.headers['set-cookie'])).not.toContain('dentalix_td');
      expect(
        await raw.userTrustedDevice.count({
          where: { userId: member.userId },
        }),
      ).toBe(0);
      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: false },
      });
    });
  });

  describe('códigos de recuperación del superadmin', () => {
    it('un código entra una sola vez, avisa por correo y el aviso no lleva clínica', async () => {
      const user = await seedSuper('recupera@platform.test');
      const { recoveryCodes } = await enrollPlatformAdmin(app, user);
      await forgetLastStep(user.id);
      const before = await outbox('MFA_NOTICE');
      const first = await apexPassword(app, user.email);
      const ok = await verify('localhost', {
        mfaToken: first.mfaToken,
        recoveryCode: recoveryCodes[0],
      }).expect(200);
      const status = await authed(
        'get',
        'localhost',
        (ok.body as Body).accessToken!,
        '/platform/mfa',
      ).expect(200);
      expect((status.body as Body).recoveryCodesRemaining).toBe(9);
      expect(await outbox('MFA_NOTICE')).toBe(before + 1);

      const second = await apexPassword(app, user.email);
      await verify('localhost', {
        mfaToken: second.mfaToken,
        recoveryCode: recoveryCodes[0],
      }).expect(401);
    });

    it('quien activó el MFA antes de esta versión genera sus códigos: contraseña + código, auditado', async () => {
      const user = await seedSuper('antiguo@platform.test');
      const enrolled = await enrollPlatformAdmin(app, user);
      // Como un alta anterior a DX-021-bis: MFA activo y ningún código.
      await raw.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await forgetLastStep(user.id);
      const token = enrolled.accessToken;
      const status = await authed(
        'get',
        'localhost',
        token,
        '/platform/mfa',
      ).expect(200);
      expect((status.body as Body).recoveryCodesRemaining).toBe(0);

      await authed('post', 'localhost', token, '/platform/mfa/recovery-codes')
        .send({ currentPassword: 'mala', code: totpAt(enrolled.secret) })
        .expect(400);
      const res = await authed(
        'post',
        'localhost',
        token,
        '/platform/mfa/recovery-codes',
      )
        .send({
          currentPassword: SEEDED_PASSWORD,
          code: totpAt(enrolled.secret),
        })
        .expect(200);
      const codes = (res.body as Body).recoveryCodes!;
      expect(codes).toHaveLength(10);
      const events = await raw.platformAuditEvent.findMany({
        where: {
          actorUserId: user.id,
          action: 'MFA_RECOVERY_CODES_REGENERATED',
        },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(codes[0]);
    });

    it('un token de clínica no los genera', async () => {
      await authed(
        'post',
        'localhost',
        clinic.adminToken,
        '/platform/mfa/recovery-codes',
      )
        .send({ currentPassword: SEEDED_PASSWORD, code: '123456' })
        .expect(403);
    });
  });

  describe('dispositivo de confianza', () => {
    let email: string;
    let userId: string;
    let secret: string;
    let cookie: string;

    beforeAll(async () => {
      const member = await seedMember(raw, other, ClinicRole.ASSISTANT);
      ({ email, userId } = member);
      const token = await loginAs(app, other.host, email);
      ({ secret } = await enrollMember(other.host, token));
      await forgetLastStep(userId);
    });

    it('«recordar» deja una cookie HttpOnly de 30 días y aquí solo su huella', async () => {
      const step = await login(other.host, email).expect(201);
      const res = await verify(other.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .set('User-Agent', CHROME)
        .expect(200);
      const set = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('dentalix_td='),
      )!;
      expect(set).toContain('HttpOnly');
      expect(set).toContain('SameSite=Strict');
      expect(set).toContain('Path=/api/v1/auth');
      expect(set).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
      cookie = set.split(';')[0];
      const rows = await raw.userTrustedDevice.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe('Chrome en macOS');
      expect(rows[0].tokenHash).not.toContain(cookie.split('=')[1]);
      const audit = await raw.auditEvent.findMany({
        where: { tenantId: other.tenantId, actorUserId: userId },
        select: { metadata: true },
      });
      expect(JSON.stringify(audit)).toContain('MFA_TRUSTED_DEVICE_ADDED');
      expect(JSON.stringify(audit)).not.toContain(cookie.split('=')[1]);
    });

    it('sin modo cookie no se guarda nada', async () => {
      await forgetLastStep(userId);
      const step = await login(other.host, email).expect(201);
      await verify(other.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(secret),
        rememberDevice: true,
      }).expect(200);
      expect(await raw.userTrustedDevice.count({ where: { userId } })).toBe(1);
    });

    it('con la cookie entra sin código; sin ella o para otro usuario se pide', async () => {
      const trusted = await login(other.host, email)
        .set('Cookie', cookie)
        .expect(201);
      expect((trusted.body as Body).accessToken).toEqual(expect.any(String));
      expect((await login(other.host, email).expect(201)).body).toMatchObject({
        mfa: 'MFA_REQUIRED',
      });

      const stranger = await seedMember(raw, other, ClinicRole.RECEPTION);
      const token = await loginAs(app, other.host, stranger.email);
      await enrollMember(other.host, token);
      const res = await login(other.host, stranger.email)
        .set('Cookie', cookie)
        .expect(201);
      expect((res.body as Body).mfa).toBe('MFA_REQUIRED');
    });

    it('la cookie copiada no vale en otra clínica del mismo usuario', async () => {
      const shared = await raw.clinicMembership.create({
        data: {
          tenantId: clinic.tenantId,
          userId,
          role: ClinicRole.ASSISTANT,
        },
        select: { id: true },
      });
      const res = await login(clinic.host, email)
        .set('Cookie', cookie)
        .expect(201);
      expect((res.body as Body).mfa).toBe('MFA_REQUIRED');
      await raw.clinicMembership.update({
        where: { id: shared.id },
        data: { deletedAt: new Date() },
      });
    });

    it('se lista y se revoca; el de otro usuario es 404', async () => {
      const trusted = await login(other.host, email)
        .set('Cookie', cookie)
        .expect(201);
      const token = (trusted.body as Body).accessToken!;
      const list = await authed(
        'get',
        other.host,
        token,
        '/me/mfa/trusted-devices',
      ).expect(200);
      const devices = list.body as { id: string; label: string }[];
      expect(devices).toHaveLength(1);
      expect(devices[0]).not.toHaveProperty('tokenHash');

      const strangerToken = await login(
        clinic.host,
        `owner@${clinic.subdomain}.test`,
      ).expect(201);
      await authed(
        'delete',
        clinic.host,
        (strangerToken.body as Body).accessToken!,
        `/me/mfa/trusted-devices/${devices[0].id}`,
      ).expect(404);

      await authed(
        'delete',
        other.host,
        token,
        `/me/mfa/trusted-devices/${devices[0].id}`,
      ).expect(204);
      const after = await login(other.host, email)
        .set('Cookie', cookie)
        .expect(201);
      expect((after.body as Body).mfa).toBe('MFA_REQUIRED');
      const audit = await raw.auditEvent.findMany({
        where: { tenantId: other.tenantId, actorUserId: userId },
        select: { metadata: true },
      });
      expect(JSON.stringify(audit)).toContain('MFA_TRUSTED_DEVICES_REVOKED');
      expect(JSON.stringify(audit)).toContain('MFA_TRUSTED_DEVICE_USED');
    });

    it('cambiar la contraseña lo invalida', async () => {
      await forgetLastStep(userId);
      const step = await login(other.host, email).expect(201);
      const res = await verify(other.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      const fresh = (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('dentalix_td='))!
        .split(';')[0];
      await authed(
        'post',
        other.host,
        (res.body as Body).accessToken!,
        '/me/password',
      )
        .send({ currentPassword: SEEDED_PASSWORD, newPassword: 'Caracas2026!' })
        .expect(200);
      const after = await login(other.host, email, 'Caracas2026!')
        .set('Cookie', fresh)
        .expect(201);
      expect((after.body as Body).mfa).toBe('MFA_REQUIRED');
    });
  });

  describe('política «obligatorio para todos»', () => {
    it('cierra las sesiones de quienes quedan obligados, en esta clínica y con auditoría', async () => {
      const site = await registerClinic(app, 'clinica-bis-todos', VENEZUELA);
      const member = await seedMember(raw, site, ClinicRole.RECEPTION);
      const session = await login(site.host, member.email).expect(201);
      const away = await registerClinic(app, 'clinica-bis-fuera', VENEZUELA);
      const outsider = await seedMember(raw, away, ClinicRole.RECEPTION);
      const outside = await login(away.host, outsider.email).expect(201);

      // Sin MFA propio no se puede encender.
      await authed('put', site.host, site.adminToken, '/security-policy')
        .send({ requireAdminMfa: true, requireAllMfa: true })
        .expect(409);
      const { accessToken } = await enrollMember(site.host, site.adminToken);
      const res = await authed(
        'put',
        site.host,
        accessToken,
        '/security-policy',
      )
        .send({ requireAdminMfa: false, requireAllMfa: true })
        .expect(200);
      expect(res.body).toEqual({ requireAdminMfa: true, requireAllMfa: true });

      await refresh(site.host, (session.body as Body).refreshToken!).expect(
        401,
      );
      const forced = await login(site.host, member.email).expect(201);
      expect((forced.body as Body).mfa).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((forced.body as Body).emailCodeRequired).toBeUndefined();
      // Otra clínica: nada cambia.
      await refresh(away.host, (outside.body as Body).refreshToken!).expect(
        201,
      );

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: site.tenantId,
          resourceType: 'CLINIC_SETTINGS',
          metadata: { path: ['reason'], equals: 'MFA_POLICY' },
        },
        select: { metadata: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        statusChange: { from: 'ADMIN_MFA_OPTIONAL', to: 'ALL_MFA_REQUIRED' },
        sessionsClosed: 1,
      });
    });

    it('el miembro obligado no puede desactivarla mientras dure', async () => {
      const site = await registerClinic(app, 'clinica-bis-baja', VENEZUELA);
      const member = await seedMember(raw, site, ClinicRole.DENTIST);
      const memberToken = await loginAs(app, site.host, member.email);
      const own = await enrollMember(site.host, memberToken);
      const admin = await enrollMember(site.host, site.adminToken);
      await authed('put', site.host, admin.accessToken, '/security-policy')
        .send({ requireAdminMfa: true, requireAllMfa: true })
        .expect(200);
      await forgetLastStep(member.userId);
      await authed('post', site.host, own.accessToken, '/me/mfa/disable')
        .send({ currentPassword: SEEDED_PASSWORD, code: totpAt(own.secret) })
        .expect(403);
    });
  });

  describe('clínicas nuevas', () => {
    it('nacen exigiendo el MFA a sus ADMIN: el dueño pasa por el alta forzada', async () => {
      const strict = await createE2eApp({
        override: (builder) => {
          builder
            .overrideProvider(NEW_CLINIC_REQUIRES_ADMIN_MFA)
            .useValue(true);
        },
      });
      try {
        const subdomain = 'clinica-bis-nueva';
        const email = `owner@${subdomain}.test`;
        const register = await registerVerified(
          strict,
          registerBody(VENEZUELA, {
            clinicName: 'Clínica Caracas',
            subdomain,
            email,
            password: SEEDED_PASSWORD,
            fullName: 'Dra. Mendoza',
          }),
        );
        const { tenantId } = register.body as { tenantId: string };
        await expect(
          raw.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { requireAdminMfa: true, requireAllMfa: true },
          }),
        ).resolves.toEqual({ requireAdminMfa: true, requireAllMfa: false });
        const res = await request(strict.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Tenant-Host', hostFor(subdomain))
          .send({ email, password: SEEDED_PASSWORD })
          .expect(201);
        expect((res.body as Body).mfa).toBe('MFA_ENROLLMENT_REQUIRED');
      } finally {
        await strict.close();
      }
    });
  });

  describe('reseteo por otro ADMIN', () => {
    let site: Clinic;
    let adminToken: string;
    let adminSecret: string;
    let adminId: string;

    const reset = (userId: string, code: string, token = adminToken) =>
      authed('post', site.host, token, `/staff/${userId}/mfa/reset`).send({
        currentPassword: SEEDED_PASSWORD,
        code,
        reason: 'LOST_DEVICE',
      });

    beforeAll(async () => {
      site = await registerClinic(app, 'clinica-bis-reset', VENEZUELA);
      adminId = site.adminUserId;
      const admin = await enrollMember(site.host, site.adminToken);
      adminToken = admin.accessToken;
      adminSecret = admin.secret;
    });

    beforeEach(() => forgetLastStep(adminId));

    it('borra su MFA, cierra sus sesiones y dispositivos, audita con motivo y avisa por correo', async () => {
      const member = await seedMember(raw, site, ClinicRole.ASSISTANT);
      const session = await loginAs(app, site.host, member.email);
      const own = await enrollMember(site.host, session);
      await forgetLastStep(member.userId);
      const step = await login(site.host, member.email).expect(201);
      const opened = await verify(site.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(own.secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      const cookies = opened.headers['set-cookie'] as unknown as string[];
      const device = cookies
        .find((c) => c.startsWith('dentalix_td='))!
        .split(';')[0];
      const before = await outbox('MFA_NOTICE');

      await expect(
        authed(
          'get',
          site.host,
          adminToken,
          `/staff/${member.userId}/mfa`,
        ).then((r) => (r.body as { enabled: boolean }).enabled),
      ).resolves.toBe(true);
      await reset(member.userId, totpAt(adminSecret)).expect(204);

      const row = await raw.user.findUniqueOrThrow({
        where: { id: member.userId },
        select: { mfaEnabledAt: true, mfaTotpSecretEnc: true },
      });
      expect(row).toEqual({ mfaEnabledAt: null, mfaTotpSecretEnc: null });
      expect(
        await raw.userMfaRecoveryCode.count({
          where: { userId: member.userId },
        }),
      ).toBe(0);
      expect(await outbox('MFA_NOTICE')).toBe(before + 1);
      // Con la cookie vieja entra solo con la contraseña, pero porque ya no
      // tiene MFA; lo que importa es que el dispositivo no vuelve a servir.
      await enrollMember(
        site.host,
        ((await login(site.host, member.email).expect(201)).body as Body)
          .accessToken!,
      );
      const after = await login(site.host, member.email)
        .set('Cookie', device)
        .expect(201);
      expect((after.body as Body).mfa).toBe('MFA_REQUIRED');

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: site.tenantId,
          actorUserId: adminId,
          resourceId: member.userId,
        },
        select: { metadata: true, resourceType: true, action: true },
      });
      expect(events).toEqual([
        {
          action: 'UPDATE',
          resourceType: 'STAFF_MEMBER',
          metadata: { reason: 'MFA_RESET_LOST_DEVICE' },
        },
      ]);
    });

    it('exige contraseña y código de quien lo pide', async () => {
      const target = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: site.tenantId, userId: { not: adminId } },
        select: { userId: true },
      });
      await authed(
        'post',
        site.host,
        adminToken,
        `/staff/${target.userId}/mfa/reset`,
      )
        .send({
          currentPassword: 'mala',
          code: totpAt(adminSecret),
          reason: 'LOST_DEVICE',
        })
        .expect(400);
      await reset(target.userId, '000000').expect(400);
      await authed(
        'post',
        site.host,
        adminToken,
        `/staff/${target.userId}/mfa/reset`,
      )
        .send({
          currentPassword: SEEDED_PASSWORD,
          code: totpAt(adminSecret),
          reason: 'PORQUE_SI',
        })
        .expect(400);
    });

    it('no vale para la propia cuenta: el último ADMIN solo recupera con sus códigos', async () => {
      await reset(adminId, totpAt(adminSecret)).expect(409);
    });

    it('otra clínica: 404, sin tocar nada', async () => {
      const foreign = { userId: clinic.adminUserId };
      await reset(foreign.userId, totpAt(adminSecret)).expect(404);
      await authed(
        'get',
        site.host,
        adminToken,
        `/staff/${foreign.userId}/mfa`,
      ).expect(404);
    });

    it('una cuenta con acceso a otra clínica se rechaza y queda auditado', async () => {
      const member = await seedMember(raw, site, ClinicRole.DENTIST);
      const token = await loginAs(app, site.host, member.email);
      await enrollMember(site.host, token);
      await raw.clinicMembership.create({
        data: {
          tenantId: other.tenantId,
          userId: member.userId,
          role: ClinicRole.DENTIST,
        },
      });
      await reset(member.userId, totpAt(adminSecret)).expect(409);
      const row = await raw.user.findUniqueOrThrow({
        where: { id: member.userId },
        select: { mfaEnabledAt: true },
      });
      expect(row.mfaEnabledAt).not.toBeNull();
      const refused = await raw.auditEvent.findMany({
        where: {
          tenantId: site.tenantId,
          resourceId: member.userId,
          metadata: { path: ['reason'], equals: 'MFA_RESET_REFUSED' },
        },
      });
      expect(refused).toHaveLength(1);
    });

    it('nunca a un superadmin, y un rol no ADMIN no llega', async () => {
      const member = await seedMember(raw, site, ClinicRole.RECEPTION);
      const staffToken = await loginAs(app, site.host, member.email);
      await reset(adminId, '123456', staffToken).expect(403);

      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: true },
      });
      await reset(member.userId, totpAt(adminSecret)).expect(403);
      await raw.user.update({
        where: { id: member.userId },
        data: { isPlatformAdmin: false },
      });
    });
  });

  describe('recuperación manual (docs/runbooks/mfa-support-reset.sql)', () => {
    const block = readFileSync(
      join(__dirname, '../docs/runbooks/mfa-support-reset.sql'),
      'utf8',
    ).match(/DO \$\$[\s\S]*?\$\$;/)![0];
    const run = (email: string) =>
      raw.$transaction([
        raw.$queryRaw`SELECT set_config('dentalix.mfa_reset_email', ${email}, true)`,
        raw.$executeRawUnsafe(block),
      ]);

    it('la dueña única sin móvil ni códigos recupera el acceso, con evento en su clínica y sus dispositivos muertos', async () => {
      const site = await registerClinic(app, 'clinica-bis-sola', VENEZUELA);
      const email = `owner@${site.subdomain}.test`;
      const own = await enrollMember(site.host, site.adminToken);
      await raw.tenant.update({
        where: { id: site.tenantId },
        data: { requireAdminMfa: true },
      });
      await forgetLastStep(site.adminUserId);
      const step = await login(site.host, email).expect(201);
      const opened = await verify(site.host, {
        mfaToken: (step.body as Body).mfaToken,
        code: totpAt(own.secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      const device = (opened.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('dentalix_td='))!
        .split(';')[0];

      await run(email);

      const res = await login(site.host, email)
        .set('Cookie', device)
        .expect(201);
      expect((res.body as Body).mfa).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(
        await raw.userMfaRecoveryCode.count({
          where: { userId: site.adminUserId },
        }),
      ).toBe(0);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: site.tenantId,
          resourceId: site.adminUserId,
          metadata: { path: ['reason'], equals: 'MFA_RESET_BY_SUPPORT' },
        },
        select: { actorUserId: true, action: true },
      });
      expect(events).toEqual([
        { actorUserId: site.adminUserId, action: 'UPDATE' },
      ]);
    });

    it('rechaza a un superadmin y a quien no tiene la verificación', async () => {
      const user = await seedSuper('intocable@platform.test');
      await enrollPlatformAdmin(app, user);
      await expect(run(user.email)).rejects.toThrow(/superadmin/);
      await expect(run(`owner@${clinic.subdomain}.test`)).rejects.toThrow(
        /no tiene la verificación/,
      );
      const row = await raw.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { mfaEnabledAt: true },
      });
      expect(row.mfaEnabledAt).not.toBeNull();
    });
  });

  describe('quien conoce la contraseña y falla códigos', () => {
    it('5 fallos: espera y un solo aviso; un dispositivo de confianza entra igual y cambiar la contraseña corta la espera', async () => {
      const site = await registerClinic(app, 'clinica-bis-fallos', VENEZUELA);
      const { host } = site;
      const member = await seedMember(raw, site, ClinicRole.DENTIST);
      const token = await loginAs(app, host, member.email);
      const own = await enrollMember(host, token);
      await forgetLastStep(member.userId);
      const device = await login(host, member.email).expect(201);
      const opened = await verify(host, {
        mfaToken: (device.body as Body).mfaToken,
        code: totpAt(own.secret),
        rememberDevice: true,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(200);
      const cookie = (opened.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('dentalix_td='))!
        .split(';')[0];

      const attacker = await login(host, member.email).expect(201);
      const mfaToken = (attacker.body as Body).mfaToken;
      const before = await outbox('MFA_NOTICE');
      for (let i = 0; i < 5; i += 1) {
        await verify(host, { mfaToken, code: totpAt(own.secret, -4) }).expect(
          401,
        );
      }
      await verify(host, { mfaToken, code: totpAt(own.secret) }).expect(429);
      await verify(host, { mfaToken, code: totpAt(own.secret) }).expect(429);
      expect(await outbox('MFA_NOTICE')).toBe(before + 1);
      // Acabada la espera, otro fallo la renueva sin otro correo.
      await raw.loginThrottle.updateMany({
        where: { keyHash: mfaKeyHash(member.userId) },
        data: { blockedUntil: new Date(Date.now() - 1000) },
      });
      await verify(host, { mfaToken, code: totpAt(own.secret, -4) }).expect(
        401,
      );
      expect(await outbox('MFA_NOTICE')).toBe(before + 1);

      // El dueño, desde su navegador de confianza, entra aunque haya espera.
      const owner = await login(host, member.email)
        .set('Cookie', cookie)
        .expect(201);
      const ownerToken = (owner.body as Body).accessToken!;
      expect(ownerToken).toEqual(expect.any(String));

      // Cambiar la contraseña deja fuera al atacante y borra la espera.
      await authed('post', host, ownerToken, '/me/password')
        .send({ currentPassword: SEEDED_PASSWORD, newPassword: 'Caracas2026!' })
        .expect(200);
      await login(host, member.email).expect(401);
      await forgetLastStep(member.userId);
      const fresh = await login(host, member.email, 'Caracas2026!').expect(201);
      await verify(host, {
        mfaToken: (fresh.body as Body).mfaToken,
        code: totpAt(own.secret),
      }).expect(200);
    });
  });
});
