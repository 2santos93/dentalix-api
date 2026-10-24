import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  SEEDED_PASSWORD,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { createE2eApp as createAppWith } from './support/create-e2e-app';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LOGIN_LOCKOUT_CONFIG,
} from '../src/modules/auth/domain/login-lockout';
import { PasswordService } from '../src/shared/crypto/password.service';
import { decodeBase32, totpCode } from '../src/shared/crypto/totp';

/**
 * SEC-008: acceso break-glass del superadmin a una clínica donde no es
 * miembro. Antes bastaba la contraseña para recibir un token ADMIN con
 * refresh de 30 días y sin más rastro que un `logger.warn`. Ahora exige MFA
 * (TOTP) enrolado desde la sesión de plataforma y un motivo; el token dura
 * como mucho 60 min, no lleva refresh y cada acceso deja una fila inmutable
 * en `platform_access_audit` que el ADMIN de la clínica puede listar.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();

const SUPER_EMAIL = 'soporte@platform.test';
const REASON = 'Ticket #4521: la clínica no puede cerrar caja';
const UA = 'Mozilla/5.0 (SEC-008 e2e)';

interface Body {
  accessToken?: string;
  refreshToken?: string;
  code?: string;
  message?: string;
  breakGlass?: boolean;
  expiresAt?: string;
}

function claimsOf(jwt: string): Record<string, unknown> {
  const [, body] = jwt.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** Código TOTP para un paso concreto (30 s) del secreto en base32. */
function codeAt(secret: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 30_000) + offsetSteps;
  return totpCode(decodeBase32(secret), step);
}

describe('Break-glass del superadmin (e2e, SEC-008)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let superId: string;
  let platformToken: string;
  let secret: string;

  const http = () => request(app.getHttpServer());

  function tenantLogin(host: string, body: Record<string, unknown>) {
    return http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .set('User-Agent', UA)
      .send(body);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-bg');
    other = await registerClinic(app, 'clinica-bg-otra');
    const user = await raw.user.create({
      data: {
        email: SUPER_EMAIL,
        passwordHash: await passwordService.hash(SEEDED_PASSWORD),
        fullName: 'Soporte Dentalix',
        isPlatformAdmin: true,
      },
      select: { id: true },
    });
    superId = user.id;
    platformToken = await loginAs(app, 'localhost', SUPER_EMAIL);
  });

  beforeEach(async () => {
    // Los intentos fallidos de un caso no deben bloquear la cuenta en otro.
    await raw.loginThrottle.deleteMany({});
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('sin MFA enrolado (plan de transición)', () => {
    it('solo con la contraseña ya NO recibe un token ADMIN: 401 MFA_NOT_ENROLLED', async () => {
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
      });
      expect(res.status).toBe(401);
      const body = res.body as Body;
      expect(body.accessToken).toBeUndefined();
      expect(body.code).toBe('MFA_NOT_ENROLLED');
      expect(body.message).toMatch(/verificación en dos pasos/);
    });

    it('la sesión de plataforma informa que no hay MFA', async () => {
      const res = await http()
        .get('/api/v1/platform/mfa')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(200);
      expect(res.body).toEqual({
        enabled: false,
        enabledAt: null,
        breakGlassAvailableAt: null,
      });
    });
  });

  describe('enrolado desde la sesión de plataforma', () => {
    it('alta: devuelve el secreto y el otpauth URI; el secreto queda cifrado', async () => {
      const res = await http()
        .post('/api/v1/platform/mfa/enrollment')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(200);
      const body = res.body as { secret: string; otpauthUri: string };
      expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(body.otpauthUri).toMatch(
        /^otpauth:\/\/totp\/Dentalix:soporte%40platform\.test\?secret=[A-Z2-7]{32}&issuer=Dentalix&algorithm=SHA1&digits=6&period=30$/,
      );
      secret = body.secret;

      const row = await raw.user.findUniqueOrThrow({
        where: { id: superId },
        select: { mfaTotpPendingSecretEnc: true, mfaEnabledAt: true },
      });
      expect(row.mfaEnabledAt).toBeNull();
      expect(row.mfaTotpPendingSecretEnc).not.toContain(secret);
    });

    it('un token de clínica no puede enrolar (403)', async () => {
      await http()
        .post('/api/v1/platform/mfa/enrollment')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(403);
    });

    it('confirmación con un código erróneo → 400', async () => {
      await http()
        .post('/api/v1/platform/mfa/enrollment/confirm')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ code: '000000' === codeAt(secret) ? '111111' : '000000' })
        .expect(400);
    });

    it('confirmación con el código vigente → activa el MFA', async () => {
      const res = await http()
        .post('/api/v1/platform/mfa/enrollment/confirm')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ code: codeAt(secret, -1) })
        .expect(200);
      expect((res.body as { enabled: boolean }).enabled).toBe(true);

      const row = await raw.user.findUniqueOrThrow({
        where: { id: superId },
        select: {
          mfaTotpSecretEnc: true,
          mfaTotpPendingSecretEnc: true,
          mfaEnabledAt: true,
        },
      });
      expect(row.mfaEnabledAt).not.toBeNull();
      expect(row.mfaTotpPendingSecretEnc).toBeNull();
      expect(row.mfaTotpSecretEnc).not.toContain(secret);
    });

    it('recién activado: el break-glass espera el periodo de seguridad (401 MFA_COOLDOWN)', async () => {
      // Riesgo de transición: quien robe la contraseña de un superadmin sin
      // MFA podría enrolar el suyo desde el apex. El periodo de espera da
      // margen para detectarlo (el dueño real recibe 409 al intentar el alta).
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: codeAt(secret, 1),
        breakGlassReason: REASON,
      }).expect(401);
      const body = res.body as Body & { availableAt?: string };
      expect(body.code).toBe('MFA_COOLDOWN');
      expect(body.accessToken).toBeUndefined();
      const { mfaEnabledAt } = await raw.user.findUniqueOrThrow({
        where: { id: superId },
        select: { mfaEnabledAt: true },
      });
      // Por defecto, 24 h desde el alta.
      expect(new Date(body.availableAt!).getTime()).toBe(
        mfaEnabledAt!.getTime() + 24 * 60 * 60 * 1000,
      );
      expect(await raw.platformAccessAudit.count()).toBe(0);

      // El resto de la suite simula que el periodo ya pasó.
      await raw.user.update({
        where: { id: superId },
        data: { mfaEnabledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      });
    });

    it('con el MFA activo, otra alta → 409 (no se pisa el secreto)', async () => {
      await http()
        .post('/api/v1/platform/mfa/enrollment')
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(409);
    });
  });

  describe('login break-glass', () => {
    it('solo la contraseña → 401 BREAK_GLASS_REQUIRED (pide código y motivo)', async () => {
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
      }).expect(401);
      expect((res.body as Body).code).toBe('BREAK_GLASS_REQUIRED');
      expect((res.body as Body).accessToken).toBeUndefined();
    });

    it('código sin motivo → 401 BREAK_GLASS_REQUIRED', async () => {
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: codeAt(secret),
      }).expect(401);
      expect((res.body as Body).code).toBe('BREAK_GLASS_REQUIRED');
    });

    it('motivo de menos de 10 caracteres → 400', async () => {
      await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: codeAt(secret),
        breakGlassReason: 'soporte',
      }).expect(400);
    });

    it('código incorrecto → 401 genérico y sin fila de auditoría', async () => {
      const valid = new Set([-1, 0, 1].map((o) => codeAt(secret, o)));
      const wrong = ['123456', '654321', '000001'].find((c) => !valid.has(c));
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: wrong,
        breakGlassReason: REASON,
      }).expect(401);
      expect((res.body as Body).code).toBeUndefined();
      expect((res.body as Body).message).toBe('Invalid credentials');
      expect(await raw.platformAccessAudit.count()).toBe(0);
    });

    it('contraseña incorrecta con código válido → 401 genérico', async () => {
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: 'la-que-no-es',
        mfaCode: codeAt(secret),
        breakGlassReason: REASON,
      }).expect(401);
      expect((res.body as Body).code).toBeUndefined();
    });

    it('un email inexistente o sin membresía responde igual que una contraseña mala', async () => {
      for (const email of [
        'nadie@platform.test',
        `owner@${other.subdomain}.test`,
      ]) {
        const res = await tenantLogin(clinic.host, {
          email,
          password: SEEDED_PASSWORD,
          mfaCode: '123456',
          breakGlassReason: REASON,
        }).expect(401);
        expect(res.body).toEqual({
          statusCode: 401,
          message: 'Invalid credentials',
          error: 'Unauthorized',
        });
      }
    });

    let accessToken: string;
    let usedCode: string;

    it('código + motivo → token ADMIN break-glass de ≤ 60 min, SIN refresh', async () => {
      usedCode = codeAt(secret);
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: usedCode,
        breakGlassReason: `  ${REASON}  `,
      })
        .set('X-Refresh-Transport', 'cookie')
        .expect(201);
      const body = res.body as Body;
      expect(body.refreshToken).toBeUndefined();
      expect(body.breakGlass).toBe(true);
      expect(res.headers['set-cookie']?.toString() ?? '').not.toMatch(
        /dentalix_rt=[^;]+;/,
      );
      accessToken = body.accessToken!;
      const claims = claimsOf(accessToken);
      expect(claims).toMatchObject({
        sub: superId,
        tenantId: clinic.tenantId,
        role: ClinicRole.ADMIN,
        breakGlass: true,
      });
      const ttl = (claims.exp as number) - (claims.iat as number);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60 * 60);
      expect(new Date(body.expiresAt!).getTime()).toBe(
        (claims.exp as number) * 1000,
      );

      // Con ese token trabaja como ADMIN en ESA clínica.
      await http()
        .get('/api/v1/staff')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('deja UNA fila inmutable en platform_access_audit con motivo, IP, UA y caducidad', async () => {
      const rows = await raw.platformAccessAudit.findMany();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        tenantId: clinic.tenantId,
        userId: superId,
        reason: REASON,
        userAgent: UA,
      });
      expect(row.ip).toBeTruthy();
      const claims = claimsOf(accessToken);
      expect(row.expiresAt.getTime()).toBe((claims.exp as number) * 1000);
    });

    it('el login queda en audit_events con el motivo BREAK_GLASS', async () => {
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, actorUserId: superId },
      });
      expect(events.map((e) => [e.action, e.metadata])).toContainEqual([
        'LOGIN',
        { reason: 'BREAK_GLASS' },
      ]);
    });

    it('el mismo código no se puede reutilizar (anti-replay)', async () => {
      const res = await tenantLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: usedCode,
        breakGlassReason: REASON,
      }).expect(401);
      expect((res.body as Body).code).toBeUndefined();
      expect(await raw.platformAccessAudit.count()).toBe(1);
    });

    it('POST /auth/refresh rechaza un refresh break-glass aunque esté bien firmado', async () => {
      const jwt = new JwtService();
      const forged = await jwt.signAsync(
        {
          sub: superId,
          tenantId: clinic.tenantId,
          role: ClinicRole.ADMIN,
          breakGlass: true,
          tv: 0,
        },
        {
          secret: process.env.JWT_REFRESH_SECRET,
          expiresIn: '30d',
          jwtid: 'd5b0f6f1-5d1c-4a43-9a43-6f5f7f1b2c3d',
        },
      );
      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: forged })
        .expect(401);
    });

    it('un refresh de clínica de un superadmin SIN membresía (los de antes) ya no renueva', async () => {
      const jwt = new JwtService();
      const legacy = await jwt.signAsync(
        {
          sub: superId,
          tenantId: clinic.tenantId,
          role: ClinicRole.ADMIN,
          tv: 0,
        },
        {
          secret: process.env.JWT_REFRESH_SECRET,
          expiresIn: '30d',
          jwtid: '0a3c9f55-1f0e-4f43-8d0b-2d7c41f0e8aa',
        },
      );
      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: legacy })
        .expect(401);
    });

    it('la tabla es append-only también para el rol de la app', async () => {
      const app = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        await expect(
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${clinic.tenantId}, true)`;
            await tx.$executeRaw`UPDATE platform_access_audit SET reason = 'borrado del rastro'`;
          }),
        ).rejects.toThrow();
        await expect(
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${clinic.tenantId}, true)`;
            await tx.$executeRaw`DELETE FROM platform_access_audit`;
          }),
        ).rejects.toThrow();
      } finally {
        await app.$disconnect();
      }
      expect(await raw.platformAccessAudit.count()).toBe(1);
    });
  });

  describe('GET /support-accesses', () => {
    it('el ADMIN de la clínica ve el acceso, con quién, motivo y caducidad', async () => {
      const res = await http()
        .get('/api/v1/support-accesses')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(200);
      const body = res.body as {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(body.nextCursor).toBeNull();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        userFullName: 'Soporte Dentalix',
        userEmail: SUPER_EMAIL,
        reason: REASON,
        userAgent: UA,
      });
      expect(typeof body.items[0].createdAt).toBe('string');
      expect(typeof body.items[0].expiresAt).toBe('string');
    });

    it('pagina por cursor', async () => {
      // Dos accesos más (pasos TOTP distintos: el actual ya se usó).
      await raw.user.update({
        where: { id: superId },
        data: { mfaLastUsedStep: null },
      });
      for (const offset of [-1, 1]) {
        await tenantLogin(clinic.host, {
          email: SUPER_EMAIL,
          password: SEEDED_PASSWORD,
          mfaCode: codeAt(secret, offset),
          breakGlassReason: `${REASON} (${offset})`,
        }).expect(201);
        await raw.loginThrottle.deleteMany({});
      }
      const first = await http()
        .get('/api/v1/support-accesses?limit=2')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(200);
      const page1 = first.body as {
        items: { id: string }[];
        nextCursor: string;
      };
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const second = await http()
        .get(`/api/v1/support-accesses?limit=2&cursor=${page1.nextCursor}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(200);
      const page2 = second.body as {
        items: { id: string }[];
        nextCursor: null;
      };
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      const ids = [...page1.items, ...page2.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('cursor manipulado → 400', async () => {
      await http()
        .get('/api/v1/support-accesses?cursor=no-es-un-cursor')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(400);
    });

    it('el ADMIN de OTRA clínica no ve los accesos de esta (RLS)', async () => {
      const res = await http()
        .get('/api/v1/support-accesses')
        .set('X-Tenant-Host', other.host)
        .set('Authorization', `Bearer ${other.adminToken}`)
        .expect(200);
      expect((res.body as { items: unknown[] }).items).toEqual([]);
    });

    it('un DENTIST no puede listarlos (403)', async () => {
      const member = await seedMember(raw, clinic, ClinicRole.DENTIST);
      const token = await loginAs(app, clinic.host, member.email);
      await http()
        .get('/api/v1/support-accesses')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('fuerza bruta del código', () => {
    // Política de bloqueo REAL (el resto de suites la suben, setup-e2e.ts).
    let strict: INestApplication<App>;
    beforeAll(async () => {
      strict = await createAppWith({
        override: (builder) => {
          builder
            .overrideProvider(LOGIN_LOCKOUT_CONFIG)
            .useValue(DEFAULT_LOGIN_LOCKOUT);
        },
      });
    });
    afterAll(() => strict.close());

    const strictLogin = (host: string, body: Record<string, unknown>) =>
      request(strict.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', host)
        .set('User-Agent', UA)
        .send(body);

    it('un login correcto en plataforma NO reinicia los fallos del código: tras 5, ni el bueno entra (429)', async () => {
      await raw.user.update({
        where: { id: superId },
        data: { mfaLastUsedStep: null },
      });
      const before = await raw.platformAccessAudit.count();
      const valid = new Set([-1, 0, 1].map((o) => codeAt(secret, o)));
      const wrongs = [
        '123456',
        '654321',
        '000001',
        '111111',
        '222222',
        '333333',
      ]
        .filter((c) => !valid.has(c))
        .slice(0, 5);
      for (const mfaCode of wrongs) {
        await strictLogin(clinic.host, {
          email: SUPER_EMAIL,
          password: SEEDED_PASSWORD,
          mfaCode,
          breakGlassReason: REASON,
        }).expect(401);
        // Quien tiene la contraseña entra al apex: el bloqueo de la CUENTA
        // vuelve a empezar, el del código no.
        await loginAs(strict, 'localhost', SUPER_EMAIL);
      }
      const res = await strictLogin(clinic.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
        mfaCode: codeAt(secret),
        breakGlassReason: REASON,
      }).expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect((res.body as Body).message).toMatch(/Demasiados intentos/);
      expect(await raw.platformAccessAudit.count()).toBe(before);
    });
  });

  describe('regresión: login normal con membresía', () => {
    it('igual que siempre: par de tokens con refresh y sin breakGlass', async () => {
      const res = await tenantLogin(clinic.host, {
        email: `owner@${clinic.subdomain}.test`,
        password: SEEDED_PASSWORD,
      }).expect(201);
      const body = res.body as Body;
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.breakGlass).toBeUndefined();
      expect(claimsOf(body.accessToken!).breakGlass).toBeUndefined();
      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', clinic.host)
        .send({ refreshToken: body.refreshToken })
        .expect(201);
    });

    it('un superadmin que SÍ es miembro entra con su rol sin MFA ni motivo', async () => {
      await raw.clinicMembership.create({
        data: {
          tenantId: other.tenantId,
          userId: superId,
          role: ClinicRole.RECEPTION,
        },
      });
      const res = await tenantLogin(other.host, {
        email: SUPER_EMAIL,
        password: SEEDED_PASSWORD,
      }).expect(201);
      const body = res.body as Body;
      expect(claimsOf(body.accessToken!)).toMatchObject({
        role: ClinicRole.RECEPTION,
      });
      expect(body.refreshToken).toEqual(expect.any(String));
    });
  });
});
