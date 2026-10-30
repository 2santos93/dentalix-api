import { INestApplication } from '@nestjs/common';
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
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { PasswordService } from '../src/shared/crypto/password.service';
import { decodeBase32, totpCode } from '../src/shared/crypto/totp';
import { hashInvitationToken } from '../src/modules/invitations/application/invitation-token';

/**
 * DX-359: las rutas de personal, cuenta y MFA de plataforma que la guarda de
 * `audit-coverage.spec.ts` tenía en KNOWN_UNAUDITED dejan su evento con quién,
 * qué y el antes/después cuando aplica, en la misma transacción que el
 * cambio, y nunca un secreto (contraseña, hash, token, secreto o código TOTP).
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();
const UA = 'dx359-e2e-agent';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface AuditPage {
  items: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    actor: { id: string } | null;
    metadata: Record<string, unknown>;
  }[];
}

describe('Auditoría de personal y cuenta (e2e, DX-359)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;

  const http = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      http()
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    send: (method: 'post' | 'patch' | 'delete' | 'put', path: string) =>
      http()
        [method](`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('User-Agent', UA)
        .set('Authorization', `Bearer ${token}`),
  });

  /** Eventos de una clínica, en orden, leídos como owner (sin RLS). */
  function eventsOf(tenantId: string, where: Prisma.AuditEventWhereInput = {}) {
    return raw.auditEvent.findMany({
      where: { tenantId, ...where },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        action: true,
        resourceType: true,
        resourceId: true,
        actorUserId: true,
        actorRole: true,
        locationId: true,
        userAgent: true,
        metadata: true,
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(MAILER).useValue(mailer);
    });
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'clinica-dx359-a');
    clinicB = await registerClinic(app, 'clinica-dx359-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('POST /auth/register/verify: CREATE CLINIC del dueño (ADMIN) en su sede principal', async () => {
    const [event] = await eventsOf(clinicA.tenantId, {
      resourceType: 'CLINIC',
    });
    expect(event).toMatchObject({
      action: 'CREATE',
      resourceId: clinicA.tenantId,
      actorUserId: clinicA.adminUserId,
      actorRole: ClinicRole.ADMIN,
      locationId: locationA,
      metadata: {
        reason: 'CLINIC_REGISTERED',
        staffAccess: { after: { role: 'ADMIN', locationIds: null } },
      },
    });
    const dump = JSON.stringify(event);
    expect(dump).not.toContain(SEEDED_PASSWORD);
    expect(dump).not.toContain('owner@clinica-dx359-a.test');
    expect(dump).not.toContain('$argon2');
  });

  it('invitar, reenviar, retirar y aceptar con cuenta nueva dejan su evento, sin token, hash ni email', async () => {
    const email = 'nueva.dx359@example.com';
    const created = await as(clinicA)
      .send('post', '/staff/invitations')
      .send({ fullName: 'Nueva Persona', email, role: ClinicRole.DENTIST })
      .expect(201);
    const invitationId = (created.body as { id: string }).id;
    const firstToken = await mailer.invitationToken(email);

    mailer.clear();
    await as(clinicA)
      .send('post', `/staff/invitations/${invitationId}/resend`)
      .expect(200);
    const token = await mailer.invitationToken(email);

    // Otra invitación, retirada.
    const other = await as(clinicA)
      .send('post', '/staff/invitations')
      .send({
        fullName: 'Retirada',
        email: 'retirada.dx359@example.com',
        role: ClinicRole.RECEPTION,
      })
      .expect(201);
    const otherId = (other.body as { id: string }).id;
    await as(clinicA)
      .send('delete', `/staff/invitations/${otherId}`)
      .expect(204);

    const accepted = await http()
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', clinicA.host)
      .set('User-Agent', UA)
      .send({ password: 'NuevaPass123!' })
      .expect(201);
    expect((accepted.body as Tokens).accessToken).toEqual(expect.any(String));
    const user = await raw.user.findFirstOrThrow({
      where: { email },
      select: { id: true },
    });

    const invitationEvents = await eventsOf(clinicA.tenantId, {
      resourceType: 'STAFF_INVITATION',
    });
    expect(
      invitationEvents.map((e) => [e.action, e.resourceId, e.metadata]),
    ).toEqual([
      [
        'CREATE',
        invitationId,
        {
          reason: 'INVITATION_SENT',
          staffAccess: { after: { role: 'DENTIST' } },
        },
      ],
      ['UPDATE', invitationId, { reason: 'INVITATION_RESENT' }],
      [
        'CREATE',
        otherId,
        {
          reason: 'INVITATION_SENT',
          staffAccess: { after: { role: 'RECEPTION' } },
        },
      ],
      [
        'VOID',
        otherId,
        {
          reason: 'INVITATION_REVOKED',
          statusChange: { from: 'PENDING', to: 'REVOKED' },
        },
      ],
    ]);
    for (const e of invitationEvents) {
      expect(e).toMatchObject({
        actorUserId: clinicA.adminUserId,
        actorRole: ClinicRole.ADMIN,
        userAgent: UA,
      });
    }

    const [acceptance] = await eventsOf(clinicA.tenantId, {
      resourceType: 'STAFF_MEMBER',
      resourceId: user.id,
    });
    expect(acceptance).toMatchObject({
      action: 'CREATE',
      actorUserId: user.id,
      actorRole: ClinicRole.DENTIST,
      userAgent: UA,
      metadata: {
        reason: 'INVITATION_ACCEPTED',
        params: { invitationId },
        staffAccess: { after: { role: 'DENTIST', locationIds: null } },
      },
    });

    const dump = JSON.stringify(await eventsOf(clinicA.tenantId));
    for (const secret of [
      token,
      firstToken,
      hashInvitationToken(token),
      hashInvitationToken(firstToken),
      'NuevaPass123!',
      email,
      'Nueva Persona',
      '$argon2',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('PATCH /staff/:userId: antes y después de rol, sedes, registro y especialidad; sin evento si nada cambia', async () => {
    const member = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    // Restringido a la sede principal (DX-089).
    await as(clinicA)
      .send('put', `/staff/${member.userId}/locations`)
      .send({ locationIds: [locationA] })
      .expect(200);

    await as(clinicA)
      .send('patch', `/staff/${member.userId}`)
      .send({
        role: ClinicRole.DENTIST,
        professionalLicense: 'RP-359',
        professionalSpecialty: 'Ortodoncia',
        fullName: 'Nombre Nuevo',
      })
      .expect(200);
    // Ascender a ADMIN le da todas las sedes.
    await as(clinicA)
      .send('patch', `/staff/${member.userId}`)
      .send({ role: ClinicRole.ADMIN, professionalLicense: '' })
      .expect(200);
    // Lo mismo otra vez: nada cambia, ningún evento.
    await as(clinicA)
      .send('patch', `/staff/${member.userId}`)
      .send({ role: ClinicRole.ADMIN })
      .expect(200);

    const updates = await eventsOf(clinicA.tenantId, {
      resourceId: member.userId,
      action: 'UPDATE',
      metadata: { path: ['reason'], equals: 'STAFF_UPDATED' },
    });
    expect(updates.map((e) => e.metadata)).toEqual([
      {
        reason: 'STAFF_UPDATED',
        changedFields: [
          'fullName',
          'professionalLicense',
          'professionalSpecialty',
          'role',
        ],
        staffAccess: {
          before: {
            role: 'ASSISTANT',
            professionalLicense: null,
            professionalSpecialty: null,
          },
          after: {
            role: 'DENTIST',
            professionalLicense: 'RP-359',
            professionalSpecialty: 'Ortodoncia',
          },
        },
      },
      {
        reason: 'STAFF_UPDATED',
        changedFields: ['locationIds', 'professionalLicense', 'role'],
        staffAccess: {
          before: {
            role: 'DENTIST',
            locationIds: [locationA],
            professionalLicense: 'RP-359',
          },
          after: {
            role: 'ADMIN',
            locationIds: null,
            professionalLicense: null,
          },
        },
      },
    ]);
    expect(updates[0]).toMatchObject({
      actorUserId: clinicA.adminUserId,
      actorRole: ClinicRole.ADMIN,
      userAgent: UA,
    });
    expect(JSON.stringify(updates)).not.toContain('Nombre Nuevo');
  });

  it('DELETE /staff/:userId y POST /staff/:userId/reactivate: el estado antes y después; un rechazo no deja evento', async () => {
    const member = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    await as(clinicA).send('delete', `/staff/${member.userId}`).expect(204);
    // Ya desactivado: 404 y sin evento.
    await as(clinicA).send('delete', `/staff/${member.userId}`).expect(404);
    await as(clinicA)
      .send('post', `/staff/${member.userId}/reactivate`)
      .expect(200);
    // Desactivarse a sí mismo: 409 y sin evento.
    await as(clinicA)
      .send('delete', `/staff/${clinicA.adminUserId}`)
      .expect(409);

    const events = await eventsOf(clinicA.tenantId, {
      resourceId: member.userId,
    });
    expect(events.map((e) => [e.action, e.metadata])).toEqual([
      [
        'UPDATE',
        {
          reason: 'STAFF_DEACTIVATED',
          statusChange: { from: 'ACTIVE', to: 'INACTIVE' },
        },
      ],
      [
        'UPDATE',
        {
          reason: 'STAFF_REACTIVATED',
          statusChange: { from: 'INACTIVE', to: 'ACTIVE' },
        },
      ],
    ]);
    expect(
      await eventsOf(clinicA.tenantId, {
        resourceId: clinicA.adminUserId,
        metadata: { path: ['reason'], equals: 'STAFF_DEACTIVATED' },
      }),
    ).toEqual([]);
  });

  it('PATCH /me y POST /me/password: el nombre como campo y la contraseña como hecho, sin hash', async () => {
    const member = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    const token = await loginAs(app, clinicA.host, member.email);
    await as(clinicA, token)
      .send('patch', '/me')
      .send({ fullName: 'Mi Nombre Nuevo' })
      .expect(200);
    const changed = await as(clinicA, token)
      .send('post', '/me/password')
      .send({ currentPassword: SEEDED_PASSWORD, newPassword: 'OtraClave99!' })
      .expect(200);
    expect((changed.body as Tokens).accessToken).toEqual(expect.any(String));

    const events = await eventsOf(clinicA.tenantId, {
      actorUserId: member.userId,
      action: { not: 'LOGIN' },
    });
    expect(
      events.map((e) => [e.action, e.resourceType, e.resourceId, e.metadata]),
    ).toEqual([
      [
        'UPDATE',
        'STAFF_MEMBER',
        member.userId,
        { reason: 'OWN_NAME_CHANGED', changedFields: ['fullName'] },
      ],
      ['PASSWORD_CHANGE', 'SESSION', null, { reason: 'SESSIONS_REVOKED' }],
    ]);
    expect(events[1]).toMatchObject({
      actorRole: ClinicRole.DENTIST,
      userAgent: UA,
    });
    const { passwordHash } = await raw.user.findUniqueOrThrow({
      where: { id: member.userId },
      select: { passwordHash: true },
    });
    const dump = JSON.stringify(events);
    for (const secret of [
      passwordHash,
      'OtraClave99!',
      SEEDED_PASSWORD,
      'Mi Nombre Nuevo',
      '$argon2',
    ]) {
      expect(dump).not.toContain(secret);
    }
    // Contraseña actual errónea: 401 y ningún evento más.
    const fresh = (changed.body as Tokens).accessToken;
    await as(clinicA, fresh)
      .send('post', '/me/password')
      .send({ currentPassword: 'mala-clave', newPassword: 'OtraMas99!' })
      .expect(401);
    expect(
      await eventsOf(clinicA.tenantId, {
        actorUserId: member.userId,
        action: 'PASSWORD_CHANGE',
      }),
    ).toHaveLength(1);
  });

  it('aislamiento: la auditoría de la clínica B no ve ningún evento de personal de la A', async () => {
    const page = (await as(clinicB).get('/audit-events').expect(200))
      .body as AuditPage;
    expect(page.items.length).toBeGreaterThan(0); // su propio alta
    expect(
      page.items.every(
        (e) =>
          e.resourceType !== 'STAFF_INVITATION' &&
          e.resourceId !== clinicA.tenantId &&
          e.actor?.id !== clinicA.adminUserId,
      ),
    ).toBe(true);
    expect(page.items.map((e) => [e.action, e.resourceType])).toEqual([
      ['LOGIN', 'SESSION'],
      ['CREATE', 'CLINIC'],
    ]);

    // Y la A ve los suyos, con las etiquetas que mapea la web.
    const own = (
      await as(clinicA)
        .get('/audit-events?resourceType=STAFF_INVITATION')
        .expect(200)
    ).body as AuditPage;
    expect(own.items.length).toBe(4);
    expect(own.items[0].metadata).toHaveProperty('reason');
  });

  describe('plataforma (MFA del superadmin)', () => {
    const SUPER_EMAIL = 'soporte.dx359@platform.test';
    let superId: string;
    let platformToken: string;

    beforeAll(async () => {
      superId = (
        await raw.user.create({
          data: {
            email: SUPER_EMAIL,
            passwordHash: await passwordService.hash(SEEDED_PASSWORD),
            fullName: 'Soporte DX-359',
            isPlatformAdmin: true,
          },
          select: { id: true },
        })
      ).id;
      platformToken = await loginAs(app, 'localhost', SUPER_EMAIL);
    });

    const platform = (path: string) =>
      http()
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', 'localhost')
        .set('User-Agent', UA)
        .set('Authorization', `Bearer ${platformToken}`);

    function platformEvents() {
      return raw.platformAuditEvent.findMany({
        where: { actorUserId: superId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          action: true,
          resourceType: true,
          resourceId: true,
          userAgent: true,
          metadata: true,
        },
      });
    }

    it('iniciar y confirmar el alta van a platform_audit_events, sin secreto, código ni URI; un código erróneo no deja evento', async () => {
      const start = await platform('/platform/mfa/enrollment').expect(200);
      const { secret, otpauthUri } = start.body as {
        secret: string;
        otpauthUri: string;
      };
      await platform('/platform/mfa/enrollment/confirm')
        .send({ code: totpCode(decodeBase32(secret), 1) })
        .expect(400);
      const code = totpCode(
        decodeBase32(secret),
        Math.floor(Date.now() / 30_000),
      );
      await platform('/platform/mfa/enrollment/confirm')
        .send({ code })
        .expect(200);

      const events = await platformEvents();
      expect(events).toEqual([
        {
          action: 'MFA_ENROLLMENT_STARTED',
          resourceType: 'USER',
          resourceId: superId,
          userAgent: UA,
          metadata: {},
        },
        {
          action: 'MFA_ENABLED',
          resourceType: 'USER',
          resourceId: superId,
          userAgent: UA,
          metadata: {},
        },
      ]);
      const dump = JSON.stringify(events);
      for (const leaked of [secret, otpauthUri, code]) {
        expect(dump).not.toContain(leaked);
      }
      // Nada de esto entra en la auditoría de ninguna clínica.
      expect(
        await raw.auditEvent.count({ where: { actorUserId: superId } }),
      ).toBe(0);
    });

    it('POST /me/password con sesión de plataforma: PASSWORD_CHANGE en platform_audit_events', async () => {
      await platform('/me/password')
        .send({
          currentPassword: SEEDED_PASSWORD,
          newPassword: 'Plataforma99!',
        })
        .expect(200);
      const events = await platformEvents();
      expect(events.at(-1)).toEqual({
        action: 'PASSWORD_CHANGE',
        resourceType: 'USER',
        resourceId: superId,
        userAgent: UA,
        metadata: {},
      });
    });
  });
});
