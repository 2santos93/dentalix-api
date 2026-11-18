import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PasswordService } from '../src/shared/crypto/password.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { CapturingMailer } from './support/capture-mailer';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-137: «Mi perfil › Sesiones», sesiones de un miembro (ADMIN), aviso de
// inicio de sesión nuevo y «No fui yo». `raw` (DIRECT_URL) solo siembra, lee
// la auditoría y limpia lo de este archivo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'Caracas-2026!';
const SUB_A = 'sesiones-dx137-a';
const SUB_B = 'sesiones-dx137-b';
const DOMAIN = '@sesiones-dx137.com';
const OWNER_A = `owner-a${DOMAIN}`;
const OWNER_B = `owner-b${DOMAIN}`;

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface SessionBody {
  id: string;
  deviceLabel: string;
  ipPrefix: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  current: boolean;
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

async function cleanup(): Promise<void> {
  await purgeTenantsBySubdomain(raw, [SUB_A, SUB_B]);
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

describe('DX-137 · sesiones (e2e)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let tenantA: string;
  let tenantB: string;
  let member: { userId: string; email: string };
  let adminA: string;
  let adminB: string;

  const http = () => request(app.getHttpServer());

  async function login(
    sub: string,
    email: string,
    userAgent: string,
  ): Promise<Tokens> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .set('User-Agent', userAgent)
      .send({ email, password: PASSWORD })
      .expect(201);
    return res.body as Tokens;
  }

  const refresh = (sub: string, refreshToken: string) =>
    http()
      .post('/api/v1/auth/refresh')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ refreshToken });

  const authed = (
    method: 'get' | 'post' | 'delete',
    path: string,
    token: string,
    sub = SUB_A,
  ) =>
    http()
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`);

  async function seedMember(
    tenantId: string,
    local: string,
  ): Promise<{ userId: string; email: string }> {
    const email = `${local}${DOMAIN}`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: 'Recepción Petare',
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role: ClinicRole.RECEPTION },
    });
    return { userId: user.id, email };
  }

  function sessionEvents(tenantId: string, reason: string) {
    return raw.$queryRaw<
      {
        actorUserId: string;
        resourceId: string | null;
        ip: string | null;
        userAgent: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      SELECT "actorUserId", "resourceId", "ip", "userAgent", "metadata"
        FROM "audit_events"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "resourceType" = 'SESSION' AND "action" = 'DELETE'
         AND "metadata" ->> 'reason' = ${reason}
       ORDER BY "occurredAt"`;
  }

  beforeAll(async () => {
    await cleanup();
    app = await createE2eApp({
      override: (builder) => builder.overrideProvider(MAILER).useValue(mailer),
    });
    const regA = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Odontología Chacao',
        subdomain: SUB_A,
        email: OWNER_A,
        password: PASSWORD,
        fullName: 'Dra. María Pérez',
      }),
    );
    tenantA = (regA.body as { tenantId: string }).tenantId;
    const regB = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Clínica Dental Maracaibo',
        subdomain: SUB_B,
        email: OWNER_B,
        password: PASSWORD,
        fullName: 'Dr. Luis Rodríguez',
      }),
    );
    tenantB = (regB.body as { tenantId: string }).tenantId;
    member = await seedMember(tenantA, 'recepcion');
    adminA = (await login(SUB_A, OWNER_A, CHROME_WINDOWS)).accessToken;
    adminB = (await login(SUB_B, OWNER_B, CHROME_WINDOWS)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  beforeEach(() => mailer.clear());

  it('lista las sesiones de 2 navegadores con «este dispositivo» marcado, sin IP ni user-agent completos', async () => {
    const chrome = await login(SUB_A, member.email, CHROME_WINDOWS);
    const firefox = await login(SUB_A, member.email, FIREFOX_LINUX);

    const res = await authed('get', '/me/sessions', chrome.accessToken).expect(
      200,
    );
    const sessions = res.body as SessionBody[];
    expect(sessions.map((s) => s.deviceLabel).sort()).toEqual([
      'Chrome en Windows',
      'Firefox en Linux',
    ]);
    expect(sessions[0]).toMatchObject({
      current: true,
      deviceLabel: 'Chrome en Windows',
    });
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Mozilla');
    expect(body).not.toMatch(/127\.0\.0\.1\b/);
    for (const s of sessions) expect(s.ipPrefix).toBe('127.0.0.0/24');

    // Ni en la BD.
    const rows = await raw.refreshSession.findMany({
      where: { userId: member.userId },
      select: { deviceLabel: true, ipPrefix: true },
    });
    expect(JSON.stringify(rows)).not.toContain('Mozilla');
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');

    // Cerrar el otro: su siguiente refresh ya no vale (≤ 1 refresh).
    const other = sessions.find((s) => !s.current)!;
    await authed(
      'delete',
      `/me/sessions/${other.id}`,
      chrome.accessToken,
    ).expect(204);
    await refresh(SUB_A, firefox.refreshToken).expect(401);
    await refresh(SUB_A, chrome.refreshToken).expect(201);

    const events = await sessionEvents(tenantA, 'SESSION_REVOKED_BY_SELF');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: member.userId,
      resourceId: other.id,
      ip: '127.0.0.0/24',
      userAgent: null,
    });

    // Cerrar una que ya no está: 404.
    await authed(
      'delete',
      `/me/sessions/${other.id}`,
      chrome.accessToken,
    ).expect(404);
  });

  it('«cerrar todas las demás» deja solo la actual', async () => {
    const a = await login(SUB_A, member.email, SAFARI_IOS);
    const b = await login(SUB_A, member.email, FIREFOX_LINUX);
    const res = await authed(
      'post',
      '/me/sessions/revoke-others',
      a.accessToken,
    ).expect(200);
    expect(
      (res.body as { sessionsClosed: number }).sessionsClosed,
    ).toBeGreaterThanOrEqual(1);
    await refresh(SUB_A, b.refreshToken).expect(401);
    const list = await authed('get', '/me/sessions', a.accessToken).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ current: true, deviceLabel: 'Safari en iOS' }),
    ]);
  });

  // ISOLATION_COVERS: GET /staff/:userId/sessions
  // ISOLATION_COVERS: DELETE /staff/:userId/sessions/:sessionId
  // ISOLATION_COVERS: POST /staff/:userId/sessions/revoke-all
  it('el ADMIN ve y cierra las sesiones de un miembro de SU clínica; el de otra clínica recibe 404', async () => {
    const s = await login(SUB_A, member.email, FIREFOX_LINUX);
    const list = await authed(
      'get',
      `/staff/${member.userId}/sessions`,
      adminA,
    ).expect(200);
    const sessions = list.body as SessionBody[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((x) => !x.current)).toBe(true);

    // Otra clínica: ni ver ni cerrar (el miembro no existe bajo su RLS).
    await authed(
      'get',
      `/staff/${member.userId}/sessions`,
      adminB,
      SUB_B,
    ).expect(404);
    await authed(
      'delete',
      `/staff/${member.userId}/sessions/${sessions[0].id}`,
      adminB,
      SUB_B,
    ).expect(404);
    await authed(
      'post',
      `/staff/${member.userId}/sessions/revoke-all`,
      adminB,
      SUB_B,
    ).expect(404);
    await refresh(SUB_A, s.refreshToken)
      .expect(201)
      .then((r) => {
        s.refreshToken = (r.body as Tokens).refreshToken;
      });

    // Un miembro que no es ADMIN no entra.
    await authed(
      'get',
      `/staff/${member.userId}/sessions`,
      s.accessToken,
    ).expect(403);

    const res = await authed(
      'post',
      `/staff/${member.userId}/sessions/revoke-all`,
      adminA,
    ).expect(200);
    expect(
      (res.body as { sessionsClosed: number }).sessionsClosed,
    ).toBeGreaterThanOrEqual(1);
    await refresh(SUB_A, s.refreshToken).expect(401);
    const events = await sessionEvents(
      tenantA,
      'MEMBER_SESSIONS_REVOKED_BY_ADMIN',
    );
    expect(events.at(-1)?.metadata).toMatchObject({
      params: { userId: member.userId },
    });
  });

  // ISOLATION_COVERS: DELETE /me/sessions/:sessionId
  it('una persona en dos clínicas: el ADMIN de cada una solo ve las de la suya', async () => {
    await raw.clinicMembership.create({
      data: {
        tenantId: tenantB,
        userId: member.userId,
        role: ClinicRole.RECEPTION,
      },
    });
    try {
      const own = await login(SUB_A, member.email, CHROME_WINDOWS);
      await login(SUB_B, member.email, SAFARI_IOS);
      const inA = await authed(
        'get',
        `/staff/${member.userId}/sessions`,
        adminA,
      ).expect(200);
      const inB = await authed(
        'get',
        `/staff/${member.userId}/sessions`,
        adminB,
        SUB_B,
      ).expect(200);
      const idsA = (inA.body as SessionBody[]).map((s) => s.id);
      const idsB = (inB.body as SessionBody[]).map((s) => s.id);
      expect(idsB).toHaveLength(1);
      expect(idsA).not.toContain(idsB[0]);
      // Y el ADMIN de A no cierra la sesión de B aunque sea de la misma persona.
      await authed(
        'delete',
        `/staff/${member.userId}/sessions/${idsB[0]}`,
        adminA,
      ).expect(404);
      // Ni la propia persona la cierra desde el host de A (es de B).
      await authed('delete', `/me/sessions/${idsB[0]}`, own.accessToken).expect(
        404,
      );
      const stillB = await authed(
        'get',
        `/staff/${member.userId}/sessions`,
        adminB,
        SUB_B,
      ).expect(200);
      expect((stillB.body as SessionBody[]).map((s) => s.id)).toEqual(idsB);
    } finally {
      await raw.clinicMembership.deleteMany({
        where: { tenantId: tenantB, userId: member.userId },
      });
    }
  });

  it('login desde un dispositivo nuevo: UN email (no por refresh ni por repetir) y «No fui yo» revoca todo, auditado', async () => {
    const fresh = await seedMember(tenantA, 'asistente');
    // Primer dispositivo: se aprende sin aviso.
    const first = await login(SUB_A, fresh.email, CHROME_WINDOWS);
    // Uno nuevo: aviso.
    const second = await login(SUB_A, fresh.email, SAFARI_IOS);
    const match = await mailer.waitFor(
      fresh.email,
      /\/no-fui-yo\/([A-Za-z0-9_-]{43})/,
    );
    const token = match[1];
    // Refrescar y volver a entrar desde el mismo dispositivo: ningún email más.
    await refresh(SUB_A, second.refreshToken).expect(201);
    await login(SUB_A, fresh.email, SAFARI_IOS);
    await new Promise((r) => setTimeout(r, 300));
    const notices = mailer.sent.filter(
      (m) => m.to === fresh.email && /no-fui-yo/.test(m.text),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].subject).toBe(
      'Nuevo inicio de sesión en Odontología Chacao',
    );
    expect(notices[0].text).toContain('Safari en iOS');
    expect(notices[0].text).not.toContain('Mozilla');
    const outbox = await raw.emailOutbox.count({
      where: {
        tenantId: tenantA,
        template: 'NEW_LOGIN',
        referenceId: fresh.userId,
      },
    });
    expect(outbox).toBe(1);

    // «No fui yo» en el host de OTRA clínica: no existe.
    await http()
      .post('/api/v1/auth/session-alerts/not-me')
      .set('X-Tenant-Host', hostFor(SUB_B))
      .send({ token })
      .expect(404);

    const res = await http()
      .post('/api/v1/auth/session-alerts/not-me')
      .set('X-Tenant-Host', hostFor(SUB_A))
      .send({ token })
      .expect(200);
    // Ningún token en la respuesta: solo un mensaje fijo.
    expect(Object.keys(res.body as object)).toEqual(['message']);
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(JSON.stringify(res.body)).not.toContain(fresh.email);

    // Todas sus sesiones, cerradas.
    await refresh(SUB_A, first.refreshToken).expect(401);
    // Un solo uso.
    await http()
      .post('/api/v1/auth/session-alerts/not-me')
      .set('X-Tenant-Host', hostFor(SUB_A))
      .send({ token })
      .expect(404);
    // El enlace para cambiar la contraseña llega al EMAIL de la cuenta.
    const reset = await mailer.waitFor(
      fresh.email,
      /\/restablecer\/([A-Za-z0-9_-]{43})/,
    );
    const resetMails = await raw.emailOutbox.count({
      where: { tenantId: tenantA, template: 'PASSWORD_RESET' },
    });
    expect(resetMails).toBeGreaterThanOrEqual(1);
    const check = await http()
      .post('/api/v1/auth/reset-password/check')
      .set('X-Tenant-Host', hostFor(SUB_A))
      .send({ token: reset[1] })
      .expect(200);
    expect((check.body as { status: string }).status).toBe('VALID');

    const events = await sessionEvents(tenantA, 'SESSION_NOT_ME');
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(fresh.userId);
    expect(events[0].ip).toBe('127.0.0.0/24');
    expect(Number(events[0].metadata.sessionsClosed)).toBeGreaterThanOrEqual(2);
  });

  it('un refresh sin `sid` (anterior a las familias) queda en la lista y «cerrar todas las demás» lo corta', async () => {
    const legacyUser = await seedMember(tenantA, 'legado');
    const keep = await login(SUB_A, legacyUser.email, CHROME_WINDOWS);
    const other = await login(SUB_A, legacyUser.email, FIREFOX_LINUX);
    const {
      sid: _sid,
      iat: _iat,
      jti: _jti,
      ...legacyClaims
    } = claimsOf(other.refreshToken);
    const legacy = await new JwtService({}).signAsync(legacyClaims, {
      secret: process.env.JWT_REFRESH_SECRET,
      jwtid: randomUUID(),
    });
    // Revoca la familia de la que salió, para que solo quede la del legado.
    await authed('post', '/me/sessions/revoke-others', keep.accessToken).expect(
      200,
    );
    const renewed = (await refresh(SUB_A, legacy).expect(201)).body as Tokens;
    const before = await authed('get', '/me/sessions', keep.accessToken).expect(
      200,
    );
    expect((before.body as SessionBody[]).length).toBe(2);
    await authed('post', '/me/sessions/revoke-others', keep.accessToken).expect(
      200,
    );
    await refresh(SUB_A, renewed.refreshToken).expect(401);
  });

  it('un token mal formado o inventado da el mismo 404', async () => {
    for (const token of ['corto', 'A'.repeat(43)]) {
      const res = await http()
        .post('/api/v1/auth/session-alerts/not-me')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ token })
        .expect(404);
      expect((res.body as { message: string }).message).toMatch(
        /ya no es válido/,
      );
    }
  });

  it('el ADMIN ajusta el cierre por inactividad (15–240) y los miembros lo leen en /me', async () => {
    const before = await authed('get', '/security-policy', adminA).expect(200);
    expect(before.body).toMatchObject({ sessionIdleMinutes: 60 });
    await http()
      .put('/api/v1/security-policy')
      .set('X-Tenant-Host', hostFor(SUB_A))
      .set('Authorization', `Bearer ${adminA}`)
      .send({ requireAdminMfa: false, sessionIdleMinutes: 10 })
      .expect(400);
    const res = await http()
      .put('/api/v1/security-policy')
      .set('X-Tenant-Host', hostFor(SUB_A))
      .set('Authorization', `Bearer ${adminA}`)
      .send({ requireAdminMfa: false, sessionIdleMinutes: 15 })
      .expect(200);
    expect(res.body).toMatchObject({ sessionIdleMinutes: 15 });
    const s = await login(SUB_A, member.email, CHROME_WINDOWS);
    const me = await authed('get', '/me', s.accessToken).expect(200);
    expect(me.body).toMatchObject({ sessionIdleMinutes: 15 });
    const audit = await raw.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "audit_events"
       WHERE "tenantId" = ${tenantA}::uuid
         AND "resourceType" = 'CLINIC_SETTINGS'
         AND "metadata" ->> 'reason' = 'SESSION_IDLE_POLICY'`;
    expect(Number(audit[0].n)).toBe(1);

    // Sin refrescar más de 15 min + un TTL de access: el refresh se rechaza.
    await raw.refreshSession.updateMany({
      where: { userId: member.userId, revokedAt: null },
      data: { lastSeenAt: new Date(Date.now() - 60 * 60_000) },
    });
    const idle = await refresh(SUB_A, s.refreshToken).expect(401);
    expect(idle.body).toMatchObject({ code: 'SESSION_IDLE' });
    // Y la familia queda revocada.
    await refresh(SUB_A, s.refreshToken).expect(401);
  });
});
