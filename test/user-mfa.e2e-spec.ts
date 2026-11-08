import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  SEEDED_PASSWORD,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { createE2eApp } from './support/create-e2e-app';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LOGIN_LOCKOUT_CONFIG,
} from '../src/modules/auth/domain/login-lockout';
import { PasswordService } from '../src/shared/crypto/password.service';
import { MFA_MESSAGES } from '../src/modules/auth/domain/user-mfa';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import { enrollmentEmailCode } from './support/platform-mfa';
import { currentTotpStep, totpAt as codeAt } from './support/totp';

/**
 * DX-021: verificación en dos pasos (TOTP) de los miembros de una clínica,
 * contra Postgres: alta desde «Mi perfil», login en dos pasos con token
 * intermedio que no da acceso a datos, anti-replay, bloqueo por intentos
 * (el bloqueo REAL: LOGIN_LOCKOUT_CONFIG por defecto), códigos de
 * recuperación de un solo uso, baja con re-autenticación, política por
 * clínica con alta forzada y el superadmin miembro sin MFA.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();

interface Body {
  accessToken?: string;
  refreshToken?: string;
  mfa?: string;
  mfaToken?: string;
  expiresAt?: string;
  emailCodeRequired?: boolean;
  emailCodeRef?: string;
  code?: string;
  message?: string;
  secret?: string;
  otpauthUri?: string;
  recoveryCodes?: string[];
  enabled?: boolean;
  required?: boolean;
  recoveryCodesRemaining?: number;
  requireAdminMfa?: boolean;
}

describe('Verificación en dos pasos de los miembros (e2e, DX-021)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let ownerEmail: string;
  let secret: string;
  let recoveryCodes: string[];

  const http = () => request(app.getHttpServer());
  const login = (host: string, email: string, password = SEEDED_PASSWORD) =>
    http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .send({ email, password });
  const verify = (host: string, body: Record<string, unknown>) =>
    http().post('/api/v1/auth/login/mfa').set('X-Tenant-Host', host).send(body);
  const me = (host: string, token: string) =>
    http()
      .get('/api/v1/me')
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
  /** El paso usado vuelve atrás: el código vigente vale otra vez (solo para encadenar casos). */
  const forgetLastStep = (userId: string) =>
    raw.user.update({
      where: { id: userId },
      data: { mfaLastUsedStep: currentTotpStep() - 5 },
    });

  beforeAll(async () => {
    // El bloqueo de verdad (5 fallos → espera), no el relajado de los e2e.
    app = await createE2eApp({
      override: (builder) => {
        builder
          .overrideProvider(LOGIN_LOCKOUT_CONFIG)
          .useValue(DEFAULT_LOGIN_LOCKOUT);
      },
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-mfa');
    other = await registerClinic(app, 'clinica-mfa-otra');
    ownerEmail = `owner@${clinic.subdomain}.test`;
  });

  beforeEach(async () => {
    await raw.loginThrottle.deleteMany({});
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('alta desde Mi perfil', () => {
    it('sin MFA: el estado lo dice y el login es el de siempre', async () => {
      const res = await http()
        .get('/api/v1/me/mfa')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(200);
      expect(res.body).toEqual({
        enabled: false,
        enabledAt: null,
        recoveryCodesRemaining: 0,
        required: false,
      });
    });

    it('empezar exige la contraseña actual (400 si no es)', async () => {
      await http()
        .post('/api/v1/me/mfa/enrollment')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ currentPassword: 'mala-mala' })
        .expect(400);
    });

    it('con la contraseña: secreto + otpauth URI; en la BD solo cifrado', async () => {
      const res = await http()
        .post('/api/v1/me/mfa/enrollment')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ currentPassword: SEEDED_PASSWORD })
        .expect(200);
      const body = res.body as Body;
      secret = body.secret!;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Dentalix:/);
      const row = await raw.user.findUniqueOrThrow({
        where: { id: clinic.adminUserId },
        select: { mfaTotpPendingSecretEnc: true, mfaEnabledAt: true },
      });
      expect(row.mfaEnabledAt).toBeNull();
      expect(row.mfaTotpPendingSecretEnc).toMatch(/^v1\./);
      expect(row.mfaTotpPendingSecretEnc).not.toContain(secret);
    });

    it('un código incorrecto no activa (400)', async () => {
      await http()
        .post('/api/v1/me/mfa/enrollment/confirm')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ code: codeAt(secret, 5) })
        .expect(400);
    });

    it('confirmar con el código: activa, 10 códigos de recuperación (en la BD solo su HMAC), sesión nueva y las demás cerradas', async () => {
      // Una sesión previa en "otro dispositivo" (refresh en el body).
      const before = await login(clinic.host, ownerEmail).expect(201);
      const oldRefresh = (before.body as Body).refreshToken!;

      const res = await http()
        .post('/api/v1/me/mfa/enrollment/confirm')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ code: codeAt(secret) })
        .expect(200);
      const body = res.body as Body;
      expect(body.enabled).toBe(true);
      expect(body.recoveryCodesRemaining).toBe(10);
      recoveryCodes = body.recoveryCodes!;
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      expect(body.accessToken).toBeDefined();
      clinic.adminToken = body.accessToken!;

      const rows = await raw.userMfaRecoveryCode.findMany({
        where: { userId: clinic.adminUserId },
      });
      expect(rows).toHaveLength(10);
      for (const r of rows) {
        expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);
        expect(recoveryCodes.map((c) => c.replace(/-/g, ''))).not.toContain(
          r.codeHash,
        );
      }
      // La otra sesión ya no renueva (tokenVersion + 1).
      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: oldRefresh })
        .expect(401);
      // Auditado sin secretos.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          actorUserId: clinic.adminUserId,
          action: 'UPDATE',
        },
      });
      const enabled = events.filter(
        (e) => (e.metadata as { reason?: string }).reason === 'MFA_ENABLED',
      );
      expect(enabled).toHaveLength(1);
      expect(JSON.stringify(enabled)).not.toContain(secret);
    });
  });

  describe('login en dos pasos', () => {
    it('la contraseña sola ya no da tokens: solo el token intermedio', async () => {
      const res = await login(clinic.host, ownerEmail).expect(201);
      const body = res.body as Body;
      expect(body.mfa).toBe('MFA_REQUIRED');
      expect(body.mfaToken).toBeDefined();
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('el token intermedio no da acceso a datos (401 en /me y en /patients) ni renueva', async () => {
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      await me(clinic.host, mfaToken!).expect(401);
      await http()
        .get('/api/v1/patients')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${mfaToken}`)
        .expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: mfaToken })
        .expect(401);
    });

    it('un código incorrecto no da acceso (401 MFA_INVALID_CODE) y queda LOGIN_FAILED', async () => {
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      const res = await verify(clinic.host, {
        mfaToken,
        code: codeAt(secret, 7),
      }).expect(401);
      expect((res.body as Body).code).toBe('MFA_INVALID_CODE');
      expect((res.body as Body).accessToken).toBeUndefined();
      const failed = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          action: 'LOGIN_FAILED',
          actorUserId: clinic.adminUserId,
        },
      });
      expect(
        failed.map((e) => (e.metadata as { reason?: string }).reason),
      ).toContain('INVALID_MFA_CODE');
    });

    it('con el código correcto: sesión normal (refresh con familia y gracia) y LOGIN MFA_TOTP', async () => {
      await forgetLastStep(clinic.adminUserId);
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      const res = await verify(clinic.host, {
        mfaToken,
        code: codeAt(secret),
      }).expect(200);
      const body = res.body as Body;
      await me(clinic.host, body.accessToken!).expect(200);
      // El refresh rota como cualquier login (familia `sid`) y respeta la gracia.
      const r1 = await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: body.refreshToken })
        .expect(201);
      const again = await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: body.refreshToken })
        .expect(201);
      // Gracia: se reemite el token VIGENTE de la familia (mismo sid/jti/exp).
      const claims = (jwt: string) =>
        JSON.parse(
          Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'),
        ) as {
          sid: string;
          jti: string;
          exp: number;
        };
      const current = claims((r1.body as Body).refreshToken!);
      const reissued = claims((again.body as Body).refreshToken!);
      expect(reissued).toMatchObject({
        sid: current.sid,
        jti: current.jti,
        exp: current.exp,
      });
      expect(current.sid).toBe(claims(body.refreshToken!).sid);
      const ok = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          action: 'LOGIN',
          actorUserId: clinic.adminUserId,
        },
      });
      expect(
        ok.map((e) => (e.metadata as { reason?: string }).reason),
      ).toContain('MFA_TOTP');
    });

    it('replay: el mismo código ya usado no vale otra vez dentro de su ventana', async () => {
      await forgetLastStep(clinic.adminUserId);
      const code = codeAt(secret);
      const first = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      await verify(clinic.host, { mfaToken: first.mfaToken, code }).expect(200);
      const second = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      const res = await verify(clinic.host, {
        mfaToken: second.mfaToken,
        code,
      }).expect(401);
      expect((res.body as Body).code).toBe('MFA_INVALID_CODE');
    });

    it('el token intermedio es de un solo uso y solo vale en su clínica', async () => {
      await forgetLastStep(clinic.adminUserId);
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      // En otra clínica: caducado (aunque el código fuera bueno).
      const cross = await verify(other.host, {
        mfaToken,
        code: codeAt(secret),
      }).expect(401);
      expect((cross.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');
      await verify(clinic.host, { mfaToken, code: codeAt(secret) }).expect(200);
      await forgetLastStep(clinic.adminUserId);
      const reused = await verify(clinic.host, {
        mfaToken,
        code: codeAt(secret),
      }).expect(401);
      expect((reused.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');
    });

    it('sin código o con los dos → 400', async () => {
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      await verify(clinic.host, { mfaToken }).expect(400);
      await verify(clinic.host, {
        mfaToken,
        code: '123456',
        recoveryCode: recoveryCodes[0],
      }).expect(400);
    });

    it('fuerza bruta: 5 códigos fallidos → 429 con Retry-After, también con el código correcto', async () => {
      await forgetLastStep(clinic.adminUserId);
      const { mfaToken } = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      for (let i = 0; i < DEFAULT_LOGIN_LOCKOUT.freeFailures; i++) {
        await verify(clinic.host, { mfaToken, code: '000000' }).expect(401);
      }
      const locked = await verify(clinic.host, {
        mfaToken,
        code: codeAt(secret),
      }).expect(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      // Un login con la contraseña correcta NO borra el contador del código.
      const fresh = (await login(clinic.host, ownerEmail).expect(201))
        .body as Body;
      await verify(clinic.host, {
        mfaToken: fresh.mfaToken,
        code: codeAt(secret),
      }).expect(429);
    });

    it('un código de recuperación funciona una sola vez (LOGIN MFA_RECOVERY_CODE)', async () => {
      const a = (await login(clinic.host, ownerEmail).expect(201)).body as Body;
      const ok = await verify(clinic.host, {
        mfaToken: a.mfaToken,
        recoveryCode: recoveryCodes[0].toLowerCase(),
      }).expect(200);
      expect((ok.body as Body).accessToken).toBeDefined();
      const b = (await login(clinic.host, ownerEmail).expect(201)).body as Body;
      await verify(clinic.host, {
        mfaToken: b.mfaToken,
        recoveryCode: recoveryCodes[0],
      }).expect(401);
      const used = await raw.userMfaRecoveryCode.count({
        where: { userId: clinic.adminUserId, usedAt: { not: null } },
      });
      expect(used).toBe(1);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          action: 'LOGIN',
          actorUserId: clinic.adminUserId,
        },
      });
      expect(
        events.map((e) => (e.metadata as { reason?: string }).reason),
      ).toContain('MFA_RECOVERY_CODE');
      expect(JSON.stringify(events)).not.toContain(recoveryCodes[0]);
    });

    it('el MFA es del usuario: se pide en todas sus clínicas', async () => {
      await raw.clinicMembership.create({
        data: {
          tenantId: other.tenantId,
          userId: clinic.adminUserId,
          role: ClinicRole.DENTIST,
        },
      });
      const res = await login(other.host, ownerEmail).expect(201);
      expect((res.body as Body).mfa).toBe('MFA_REQUIRED');
    });
  });

  describe('desactivar (re-autenticación)', () => {
    const disable = (body: Record<string, unknown>) =>
      http()
        .post('/api/v1/me/mfa/disable')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send(body);

    it('sin contraseña correcta o sin código válido: 400 y sigue activo', async () => {
      await forgetLastStep(clinic.adminUserId);
      await disable({
        currentPassword: 'mala-mala',
        code: codeAt(secret),
      }).expect(400);
      await disable({
        currentPassword: SEEDED_PASSWORD,
        code: '000000',
      }).expect(400);
      const row = await raw.user.findUniqueOrThrow({
        where: { id: clinic.adminUserId },
        select: { mfaEnabledAt: true },
      });
      expect(row.mfaEnabledAt).not.toBeNull();
    });

    it('regenerar códigos invalida los anteriores', async () => {
      await forgetLastStep(clinic.adminUserId);
      const res = await http()
        .post('/api/v1/me/mfa/recovery-codes')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ currentPassword: SEEDED_PASSWORD, code: codeAt(secret) })
        .expect(200);
      const fresh = (res.body as Body).recoveryCodes!;
      expect(fresh).toHaveLength(10);
      const a = (await login(clinic.host, ownerEmail).expect(201)).body as Body;
      await verify(clinic.host, {
        mfaToken: a.mfaToken,
        recoveryCode: recoveryCodes[1],
      }).expect(401);
      recoveryCodes = fresh;
    });

    it('con contraseña + código: desactiva, borra códigos, cierra las demás sesiones y vuelve el login de siempre', async () => {
      await forgetLastStep(clinic.adminUserId);
      const res = await disable({
        currentPassword: SEEDED_PASSWORD,
        code: codeAt(secret),
      }).expect(200);
      clinic.adminToken = (res.body as Body).accessToken!;
      await me(clinic.host, clinic.adminToken).expect(200);
      expect(
        await raw.userMfaRecoveryCode.count({
          where: { userId: clinic.adminUserId },
        }),
      ).toBe(0);
      const row = await raw.user.findUniqueOrThrow({
        where: { id: clinic.adminUserId },
        select: { mfaEnabledAt: true, mfaTotpSecretEnc: true },
      });
      expect(row).toEqual({ mfaEnabledAt: null, mfaTotpSecretEnc: null });
      const plain = await login(clinic.host, ownerEmail).expect(201);
      expect((plain.body as Body).accessToken).toBeDefined();
      const reasons = (
        await raw.auditEvent.findMany({
          where: {
            tenantId: clinic.tenantId,
            actorUserId: clinic.adminUserId,
            action: 'UPDATE',
          },
        })
      ).map((e) => (e.metadata as { reason?: string }).reason);
      expect(reasons).toEqual(
        expect.arrayContaining([
          'MFA_ENABLED',
          'MFA_RECOVERY_CODES_REGENERATED',
          'MFA_DISABLED',
        ]),
      );
    });
  });

  describe('política de la clínica y alta forzada', () => {
    let second: { userId: string; email: string };

    it('solo ADMIN ve la política; encenderla exige tener el MFA propio', async () => {
      const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
      const dentistLogin = await login(clinic.host, dentist.email).expect(201);
      await http()
        .get('/api/v1/security-policy')
        .set('X-Tenant-Host', clinic.host)
        .set(
          'Authorization',
          `Bearer ${(dentistLogin.body as Body).accessToken}`,
        )
        .expect(403);
      await http()
        .put('/api/v1/security-policy')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ requireAdminMfa: true })
        .expect(409);
    });

    it('con el MFA propio la enciende (auditado) y otro ADMIN sin MFA pasa por el alta forzada', async () => {
      // El dueño vuelve a activar su MFA.
      const start = await http()
        .post('/api/v1/me/mfa/enrollment')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ currentPassword: SEEDED_PASSWORD })
        .expect(200);
      secret = (start.body as Body).secret!;
      const enabled = await http()
        .post('/api/v1/me/mfa/enrollment/confirm')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ code: codeAt(secret) })
        .expect(200);
      clinic.adminToken = (enabled.body as Body).accessToken!;
      const put = await http()
        .put('/api/v1/security-policy')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({ requireAdminMfa: true })
        .expect(200);
      expect((put.body as Body).requireAdminMfa).toBe(true);
      const policyEvents = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'CLINIC_SETTINGS' },
      });
      expect(policyEvents.map((e) => e.metadata)).toContainEqual({
        reason: 'MFA_POLICY',
        statusChange: { from: 'ADMIN_MFA_OPTIONAL', to: 'ADMIN_MFA_REQUIRED' },
        sessionsClosed: 0,
      });

      // Otro ADMIN, sin MFA: la contraseña no le da tokens, solo el alta.
      second = await seedMember(raw, clinic, ClinicRole.ADMIN);
      const res = await login(clinic.host, second.email).expect(201);
      const body = res.body as Body;
      expect(body.mfa).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(body.accessToken).toBeUndefined();
      // El token del alta tampoco sirve para el paso del código.
      await verify(clinic.host, {
        mfaToken: body.mfaToken,
        code: '123456',
      }).expect(401);
      // SEC-066: la contraseña sola no enrola: hace falta el código del correo.
      expect(body.emailCodeRequired).toBe(true);
      const emailCode = enrollmentEmailCode(app, body.mfaToken!);
      const st = await http()
        .post('/api/v1/auth/login/mfa/enrollment')
        .set('X-Tenant-Host', clinic.host)
        .send({ mfaToken: body.mfaToken, emailCode })
        .expect(200);
      const secondSecret = (st.body as Body).secret!;
      const done = await http()
        .post('/api/v1/auth/login/mfa/enrollment/confirm')
        .set('X-Tenant-Host', clinic.host)
        .send({
          mfaToken: body.mfaToken,
          emailCode,
          code: codeAt(secondSecret),
        })
        .expect(200);
      const doneBody = done.body as Body;
      expect(doneBody.recoveryCodes).toHaveLength(10);
      await me(clinic.host, doneBody.accessToken!).expect(200);
      // Su estado: obligatorio.
      const status = await http()
        .get('/api/v1/me/mfa')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${doneBody.accessToken}`)
        .expect(200);
      expect(status.body).toMatchObject({
        enabled: true,
        required: true,
        recoveryCodesRemaining: 10,
      });
      // Y no puede desactivarla mientras la clínica la exija.
      await http()
        .post('/api/v1/me/mfa/disable')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${doneBody.accessToken}`)
        .send({
          currentPassword: SEEDED_PASSWORD,
          recoveryCode: doneBody.recoveryCodes![0],
        })
        .expect(403);
    });

    it('la política no afecta a los demás roles', async () => {
      const assistant = await seedMember(raw, clinic, ClinicRole.ASSISTANT);
      const res = await login(clinic.host, assistant.email).expect(201);
      expect((res.body as Body).accessToken).toBeDefined();
    });
  });

  describe('alta forzada de un miembro con código por correo (SEC-066)', () => {
    let site: Clinic;
    let reception: { userId: string; email: string };
    let dentist: { userId: string; email: string };
    const enroll = (host: string, body: Record<string, unknown>) =>
      http()
        .post('/api/v1/auth/login/mfa/enrollment')
        .set('X-Tenant-Host', host)
        .send(body);
    const confirm = (host: string, body: Record<string, unknown>) =>
      http()
        .post('/api/v1/auth/login/mfa/enrollment/confirm')
        .set('X-Tenant-Host', host)
        .send(body);
    const failedEmailCodes = () =>
      raw.auditEvent.count({
        where: {
          tenantId: site.tenantId,
          actorUserId: reception.userId,
          action: 'LOGIN_FAILED',
          metadata: { path: ['reason'], equals: 'INVALID_EMAIL_CODE' },
        },
      });

    beforeAll(async () => {
      site = await registerClinic(app, 'clinica-mfa-sec066');
      // La dueña activa su MFA y exige la verificación a TODA la plantilla.
      const start = await http()
        .post('/api/v1/me/mfa/enrollment')
        .set('X-Tenant-Host', site.host)
        .set('Authorization', `Bearer ${site.adminToken}`)
        .send({ currentPassword: SEEDED_PASSWORD })
        .expect(200);
      const enabled = await http()
        .post('/api/v1/me/mfa/enrollment/confirm')
        .set('X-Tenant-Host', site.host)
        .set('Authorization', `Bearer ${site.adminToken}`)
        .send({ code: codeAt((start.body as Body).secret!) })
        .expect(200);
      await http()
        .put('/api/v1/security-policy')
        .set('X-Tenant-Host', site.host)
        .set('Authorization', `Bearer ${(enabled.body as Body).accessToken}`)
        .send({ requireAdminMfa: true, requireAllMfa: true })
        .expect(200);
      reception = await seedMember(raw, site, ClinicRole.RECEPTION);
      dentist = await seedMember(raw, site, ClinicRole.DENTIST);
    });

    // Un correo por cuenta y cliente cada minuto (DX-021-bis): cada caso entra
    // de nuevo desde la misma IP, así que se olvidan los enviados.
    beforeEach(async () => {
      await raw.emailOutbox.deleteMany({
        where: { template: 'MFA_ENROLLMENT_CODE' },
      });
    });

    it('la contraseña da el paso del alta y envía un código al correo de la cuenta (sin enumeración: solo tras la contraseña correcta)', async () => {
      const toHash = app
        .get(EmailPayloadCipher, { strict: false })
        .hashRecipient(reception.email);
      const before = await raw.emailOutbox.count({
        where: { toHash, template: 'MFA_ENROLLMENT_CODE' },
      });
      // Contraseña mala: el 401 genérico de siempre y ningún correo.
      const bad = await login(site.host, reception.email, 'otra-clave-mala');
      expect(bad.status).toBe(401);
      expect(JSON.stringify(bad.body)).not.toContain(reception.email);
      const res = await login(site.host, reception.email).expect(201);
      const body = res.body as Body;
      expect(body).toMatchObject({
        mfa: 'MFA_ENROLLMENT_REQUIRED',
        emailCodeRequired: true,
      });
      expect(body.emailCodeRef).toMatch(/^[0-9A-F]{4}$/);
      expect(body.accessToken).toBeUndefined();
      expect(
        await raw.emailOutbox.count({
          where: { toHash, template: 'MFA_ENROLLMENT_CODE' },
        }),
      ).toBe(before + 1);
    });

    it('sin el código del correo, con uno malo o con el de otra cuenta: 400, ni secreto ni sesión ni códigos; queda auditado', async () => {
      const step = await login(site.host, reception.email).expect(201);
      const mfaToken = (step.body as Body).mfaToken!;
      const mine = enrollmentEmailCode(app, mfaToken);
      const otherStep = await login(site.host, dentist.email).expect(201);
      const theirs = enrollmentEmailCode(
        app,
        (otherStep.body as Body).mfaToken!,
      );
      const failed = await failedEmailCodes();

      const missing = await enroll(site.host, { mfaToken }).expect(400);
      expect((missing.body as Body).message).toBe(
        MFA_MESSAGES.emailCodeInvalid,
      );
      expect((missing.body as Body).secret).toBeUndefined();
      const wrongCode = mine === '00000000' ? '11111111' : '00000000';
      await enroll(site.host, { mfaToken, emailCode: wrongCode }).expect(400);
      if (theirs !== mine) {
        await enroll(site.host, { mfaToken, emailCode: theirs }).expect(400);
      }
      // Confirmar sin el código tampoco abre sesión ni da códigos.
      const noCode = await confirm(site.host, {
        mfaToken,
        code: '123456',
      }).expect(400);
      expect((noCode.body as Body).accessToken).toBeUndefined();
      expect((noCode.body as Body).recoveryCodes).toBeUndefined();

      expect(await failedEmailCodes()).toBe(failed + (theirs !== mine ? 4 : 3));
      const row = await raw.user.findUniqueOrThrow({
        where: { id: reception.userId },
        select: { mfaEnabledAt: true, mfaTotpPendingSecretEnc: true },
      });
      expect(row).toEqual({
        mfaEnabledAt: null,
        mfaTotpPendingSecretEnc: null,
      });
    });

    it('el token del alta y su código no valen en otra clínica (401)', async () => {
      const step = await login(site.host, reception.email).expect(201);
      const mfaToken = (step.body as Body).mfaToken!;
      const res = await enroll(other.host, {
        mfaToken,
        emailCode: enrollmentEmailCode(app, mfaToken),
      }).expect(401);
      expect((res.body as Body).code).toBe('MFA_CHALLENGE_EXPIRED');
    });

    it('con el código del correo: secreto, activación, sesión y 10 códigos; el token y su código no se reutilizan', async () => {
      const step = await login(site.host, reception.email).expect(201);
      const mfaToken = (step.body as Body).mfaToken!;
      const emailCode = enrollmentEmailCode(app, mfaToken);
      const st = await enroll(site.host, { mfaToken, emailCode }).expect(200);
      const ownSecret = (st.body as Body).secret!;
      const done = await confirm(site.host, {
        mfaToken,
        emailCode,
        code: codeAt(ownSecret),
      }).expect(200);
      const doneBody = done.body as Body;
      expect(doneBody.recoveryCodes).toHaveLength(10);
      await me(site.host, doneBody.accessToken!).expect(200);
      await confirm(site.host, {
        mfaToken,
        emailCode,
        code: codeAt(ownSecret),
      }).expect(401);

      const events = await raw.auditEvent.findMany({
        where: { tenantId: site.tenantId, actorUserId: reception.userId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { action: true, metadata: true },
      });
      const reasons = events.map((e) => [
        e.action,
        (e.metadata as { reason?: string } | null)?.reason,
      ]);
      expect(reasons).toEqual(
        expect.arrayContaining([
          ['UPDATE', 'MFA_ENROLLMENT_STARTED'],
          ['UPDATE', 'MFA_ENABLED'],
          ['LOGIN', 'MFA_ENROLLED'],
        ]),
      );
      const dump = JSON.stringify(events);
      expect(dump).not.toContain(emailCode);
      expect(dump).not.toContain(ownSecret);
    });
  });

  describe('superadmin miembro de una clínica', () => {
    it('sin MFA no entra: alta forzada (obligatorio para isPlatformAdmin)', async () => {
      const email = 'soporte-miembro@platform.test';
      const user = await raw.user.create({
        data: {
          email,
          passwordHash: await passwordService.hash(SEEDED_PASSWORD),
          fullName: 'Soporte miembro',
          isPlatformAdmin: true,
        },
        select: { id: true },
      });
      await raw.clinicMembership.create({
        data: {
          tenantId: other.tenantId,
          userId: user.id,
          role: ClinicRole.RECEPTION,
        },
      });
      const res = await login(other.host, email).expect(201);
      expect((res.body as Body).mfa).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((res.body as Body).accessToken).toBeUndefined();
    });
  });
});
