import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { WeeklyDigestSender } from '../src/modules/weekly-digest/application/weekly-digest-sender';
import {
  WEEKLY_DIGEST_HOUR_MESSAGE,
  WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE,
  WEEKLY_DIGEST_RECIPIENTS_MESSAGE,
  WEEKLY_DIGEST_WEEKDAY_MESSAGE,
} from '../src/modules/weekly-digest/application/weekly-digest-settings.use-cases';
import { WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE } from '../src/modules/weekly-digest/application/weekly-digest-unsubscribe.use-cases';
import { previousFullWeek } from '../src/modules/weekly-digest/domain/weekly-digest-schedule';
import { WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE } from '../src/modules/weekly-digest/presentation/dto/weekly-digest.dto';
import { WEEKLY_DIGEST_FORBIDDEN_MESSAGE } from '../src/modules/weekly-digest/presentation/weekly-digest-settings.controller';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { civilDateIn } from '../src/shared/time/civil-day';
import { CapturingMailer } from './support/capture-mailer';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-568 por HTTP contra Postgres: Ajustes › Resumen semanal (solo ADMIN,
// validación en español, destinatarios ADMIN activos de ESTA clínica,
// auditado con el antes y el después y sin sede), «Enviarme una prueba» (el
// email llega al buzón con «[Prueba]» y sin baja; una cada 5 minutos) y la
// baja pública en dos pasos desde el enlace de una entrega real (idempotente,
// 404 desde otra clínica, auditada con la persona del enlace como actor).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Member {
  userId: string;
  email: string;
  token: string;
  membershipId: string;
}

interface SettingsBody {
  enabled: boolean;
  weekday: number;
  hour: number;
  recipientMembershipIds: string[];
  candidates: {
    membershipId: string;
    name: string;
    email: string;
    verified: boolean;
  }[];
  warnings: string[];
}

const TOKEN_IN_EMAIL = /\/resumen\/baja\/([A-Za-z0-9_-]{43})/;

describe('Resumen semanal por email (e2e, DX-568)', () => {
  const mailer = new CapturingMailer();
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let ownerMembershipId: string;
  let locationId: string;
  let otherLocationId: string;
  let otherOwnerMembershipId: string;
  let admin2: Member;
  let dentist: Member;
  let reception: Member;
  let assistant: Member;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const pub = (req: request.Test, host = clinic.host) =>
    req.set('X-Tenant-Host', host);
  const ownerEmail = () => `owner@${clinic.subdomain}.test`;

  const getSettings = (token = clinic.adminToken, c = clinic) =>
    as(api().get('/api/v1/clinic/weekly-digest-settings'), token, c.host);
  const putSettings = (body: object, token = clinic.adminToken, c = clinic) =>
    as(api().put('/api/v1/clinic/weekly-digest-settings'), token, c.host)
      // La sede activa viaja en la petición; el evento no debe llevarla.
      .set('X-Location-Id', c === clinic ? locationId : otherLocationId)
      .send(body);
  const sendTest = (token = clinic.adminToken) =>
    as(api().post('/api/v1/clinic/weekly-digest/send-test'), token);

  async function member(role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, clinic, role);
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, userId: m.userId },
      select: { id: true },
    });
    return {
      userId: m.userId,
      email: m.email,
      token: await loginAs(app, clinic.host, m.email),
      membershipId: membership.id,
    };
  }

  const digestEvents = async (tenantId = clinic.tenantId) =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
        orderBy: { occurredAt: 'asc' },
      })
    ).filter((e) =>
      String((e.metadata as { reason?: string }).reason).startsWith(
        'WEEKLY_DIGEST_',
      ),
    );

  beforeAll(async () => {
    app = await createE2eApp((b) =>
      b.overrideProvider(MAILER).useValue(mailer),
    );
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx568-e2e');
    other = await registerClinic(app, 'dx568-e2e-otra');
    ownerMembershipId = (
      await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: clinic.tenantId, userId: clinic.adminUserId },
      })
    ).id;
    otherOwnerMembershipId = (
      await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: other.tenantId, userId: other.adminUserId },
      })
    ).id;
    const firstLocation = async (c: Clinic) =>
      (
        await raw.location.findFirstOrThrow({
          where: { tenantId: c.tenantId },
          select: { id: true },
        })
      ).id;
    locationId = await firstLocation(clinic);
    otherLocationId = await firstLocation(other);
    admin2 = await member(ClinicRole.ADMIN);
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('Ajustes', () => {
    it('solo ADMIN: el resto recibe 403 en español en las tres rutas', async () => {
      for (const m of [dentist, reception, assistant]) {
        for (const res of [
          await getSettings(m.token),
          await putSettings(
            { enabled: true, weekday: 1, hour: 7, recipientMembershipIds: [] },
            m.token,
          ),
          await sendTest(m.token),
        ]) {
          expect(res.status).toBe(403);
          expect((res.body as { message: string }).message).toBe(
            WEEKLY_DIGEST_FORBIDDEN_MESSAGE,
          );
        }
      }
      expect(await digestEvents()).toHaveLength(0);
    });

    it('por defecto: desactivado, lunes a las 7, sin destinatarios y los ADMIN como candidatos', async () => {
      const res = await getSettings().expect(200);
      const body = res.body as SettingsBody;
      expect(body).toMatchObject({
        enabled: false,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [],
        warnings: [],
      });
      expect(body.candidates.map((c) => c.membershipId).sort()).toEqual(
        [ownerMembershipId, admin2.membershipId].sort(),
      );
      // Correo enmascarado; ni la dentista ni otra clínica aparecen.
      expect(body.candidates.every((c) => c.email.includes('***@'))).toBe(true);
      expect(JSON.stringify(body)).not.toContain(ownerEmail());
    });

    it('validación en español: día, hora, ids y destinatarios que no son ADMIN activos', async () => {
      const base = {
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [ownerMembershipId],
      };
      const message = async (body: object) => {
        const res = await putSettings(body).expect(400);
        return JSON.stringify((res.body as { message: unknown }).message);
      };
      expect(await message({ ...base, weekday: 7 })).toContain(
        WEEKLY_DIGEST_WEEKDAY_MESSAGE,
      );
      expect(await message({ ...base, hour: -1 })).toContain(
        WEEKLY_DIGEST_HOUR_MESSAGE,
      );
      expect(await message({ ...base, hour: 7.5 })).toContain(
        WEEKLY_DIGEST_HOUR_MESSAGE,
      );
      expect(
        await message({ ...base, recipientMembershipIds: ['no-es-un-id'] }),
      ).toContain(WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE);
      expect(
        await message({
          ...base,
          recipientMembershipIds: [dentist.membershipId],
        }),
      ).toContain(WEEKLY_DIGEST_RECIPIENTS_MESSAGE);
      expect(await digestEvents()).toHaveLength(0);
    });

    it('B no puede apuntar como destinatario al ADMIN de A: 400 y nada cambia en ninguna', async () => {
      const res = await putSettings(
        {
          enabled: true,
          weekday: 1,
          hour: 7,
          recipientMembershipIds: [ownerMembershipId],
        },
        other.adminToken,
        other,
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        WEEKLY_DIGEST_RECIPIENTS_MESSAGE,
      );
      expect(
        await raw.weeklyDigestRecipient.count({
          where: { tenantId: { in: [clinic.tenantId, other.tenantId] } },
        }),
      ).toBe(0);
      expect(
        await raw.tenant.findUniqueOrThrow({
          where: { id: other.tenantId },
          select: { weeklyDigestEnabled: true },
        }),
      ).toEqual({ weeklyDigestEnabled: false });
      expect(await digestEvents(other.tenantId)).toHaveLength(0);
      // Y al revés: A tampoco puede apuntar al ADMIN de B.
      await putSettings({
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [otherOwnerMembershipId],
      }).expect(400);
      expect(await digestEvents()).toHaveLength(0);
    });

    it('activado sin destinatarios se permite con NO_RECIPIENTS; el cambio se audita sin sede y repetirlo no audita', async () => {
      const empty = await putSettings({
        enabled: true,
        weekday: 2,
        hour: 9,
        recipientMembershipIds: [],
      }).expect(200);
      expect((empty.body as SettingsBody).warnings).toEqual(['NO_RECIPIENTS']);

      const saved = await putSettings({
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [ownerMembershipId, admin2.membershipId],
      }).expect(200);
      expect(saved.body as SettingsBody).toMatchObject({
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [ownerMembershipId, admin2.membershipId].sort(),
        warnings: [],
      });
      await putSettings({
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: [admin2.membershipId, ownerMembershipId],
      }).expect(200);

      const events = await digestEvents();
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e).toMatchObject({
          action: 'UPDATE',
          resourceId: clinic.tenantId,
          actorUserId: clinic.adminUserId,
          locationId: null,
        });
      }
      expect(events[1].metadata).toMatchObject({
        reason: 'WEEKLY_DIGEST_SETTINGS',
        changedFields: ['hour', 'recipientMembershipIds', 'weekday'],
        configChange: {
          before: { weekday: 2, hour: 9, recipientMembershipIds: [] },
          after: {
            weekday: 1,
            hour: 7,
            recipientMembershipIds: [
              ownerMembershipId,
              admin2.membershipId,
            ].sort(),
          },
        },
      });
      await getSettings()
        .expect(200)
        .expect((r) =>
          expect((r.body as SettingsBody).recipientMembershipIds).toHaveLength(
            2,
          ),
        );
    });

    it('más de 50 destinatarios: 400 en español', async () => {
      const ids = Array.from(
        { length: 51 },
        (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      );
      const res = await putSettings({
        enabled: true,
        weekday: 1,
        hour: 7,
        recipientMembershipIds: ids,
      }).expect(400);
      expect(
        JSON.stringify((res.body as { message: unknown }).message),
      ).toContain(WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE);
    });

    it('sede principal sin formato: el GET avisa PRINCIPAL_LOCATION_UNCONFIGURED', async () => {
      const before = await raw.location.findUniqueOrThrow({
        where: { id: locationId },
        select: { locale: true },
      });
      await raw.location.update({
        where: { id: locationId },
        data: { locale: null },
      });
      try {
        const res = await getSettings().expect(200);
        expect((res.body as SettingsBody).warnings).toContain(
          'PRINCIPAL_LOCATION_UNCONFIGURED',
        );
      } finally {
        await raw.location.update({
          where: { id: locationId },
          data: { locale: before.locale },
        });
      }
      const res = await getSettings().expect(200);
      expect((res.body as SettingsBody).warnings).not.toContain(
        'PRINCIPAL_LOCATION_UNCONFIGURED',
      );
    });
  });

  describe('Enviarme una prueba', () => {
    it('llega solo a quien la pide, con «[Prueba]» y sin baja, auditada; otra antes de 5 min es 429', async () => {
      const res = await sendTest().expect(200);
      const week = previousFullWeek(civilDateIn(new Date(), 'America/Caracas'));
      expect(res.body).toEqual({
        sentTo: 'ow***@dx568-e2e.test',
        weekStart: week.weekStart,
        weekEnd: week.weekEnd,
      });
      await app.get(EmailDispatcher).whenIdle();
      await mailer.waitFor(ownerEmail(), /Resumen semanal/);
      const digests = () =>
        mailer.sent.filter(
          (m) => m.to === ownerEmail() && /Resumen semanal/.test(m.subject),
        );
      const emails = digests();
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toMatch(
        /^\[Prueba\] Resumen semanal de Clinica dx568-e2e: /,
      );
      expect(emails[0].text).not.toMatch(TOKEN_IN_EMAIL);
      expect(emails[0].html).not.toContain('Dejar de recibir');
      expect(emails[0].text).toContain('Total de la clínica');
      expect(mailer.sent.some((m) => m.to === admin2.email)).toBe(false);
      // No crea envío ni entrega: no cuenta para el semanal.
      expect(
        await raw.weeklyDigestRun.count({
          where: { tenantId: clinic.tenantId },
        }),
      ).toBe(0);
      const tests = (await digestEvents()).filter(
        (e) =>
          (e.metadata as { reason: string }).reason ===
          'WEEKLY_DIGEST_TEST_SENT',
      );
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({
        action: 'VIEW',
        actorUserId: clinic.adminUserId,
        locationId: null,
      });

      const again = await sendTest().expect(429);
      expect(again.body).toMatchObject({
        statusCode: 429,
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect((again.body as { message: string }).message).toMatch(
        /^Ya te enviamos una prueba hace un momento\. Espera \d+ minutos? para pedir otra\.$/,
      );
      await app.get(EmailDispatcher).whenIdle();
      expect(digests()).toHaveLength(1);
    });

    it('con el correo sin confirmar: 409 en español y nada sale', async () => {
      await raw.user.update({
        where: { id: admin2.userId },
        data: { emailVerifiedAt: null },
      });
      const res = await sendTest(admin2.token).expect(409);
      expect(res.body).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
        message: WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE,
      });
      await app.get(EmailDispatcher).whenIdle();
      expect(mailer.sent.some((m) => m.to === admin2.email)).toBe(false);
      // Los candidatos lo dicen, para que la web avise.
      const settings = (await getSettings().expect(200)).body as SettingsBody;
      expect(
        settings.candidates.find((c) => c.membershipId === admin2.membershipId)
          ?.verified,
      ).toBe(false);
    });
  });

  describe('Baja pública desde el enlace', () => {
    let token: string;

    beforeAll(async () => {
      const week = previousFullWeek(civilDateIn(new Date(), 'America/Caracas'));
      // Una entrega real: el envío semanal de la clínica, como el trabajo.
      const result = await app
        .get(TenantContextService)
        .run(clinic.tenantId, () =>
          app.get(WeeklyDigestSender).send(clinic.tenantId, week.weekStart),
        );
      expect(result).toBe('SENT');
      await app.get(EmailDispatcher).whenIdle();
      token = (await mailer.waitFor(ownerEmail(), TOKEN_IN_EMAIL))[1];
      // Solo el ADMIN confirmado; el sin confirmar se omite.
      expect(mailer.sent.some((m) => m.to === admin2.email)).toBe(false);
    });

    const recipientRows = () =>
      raw.weeklyDigestRecipient.count({
        where: { membershipId: ownerMembershipId },
      });

    it('abrirlo no da de baja: dice la clínica y que lo sigue recibiendo, sin caché', async () => {
      const res = await pub(
        api().get(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(200);
      expect(res.body).toEqual({
        clinicName: 'Clinica dx568-e2e',
        status: 'ACTIVE',
      });
      expect(res.headers['cache-control']).toContain('no-store');
      expect(await recipientRows()).toBe(1);
    });

    // ISOLATION_COVERS: GET /public/weekly-digest-unsubscribe/:token
    // ISOLATION_COVERS: POST /public/weekly-digest-unsubscribe/:token
    it('B → 404 con el token de A en su host, igual que uno inventado, y A sigue entre los destinatarios', async () => {
      for (const verb of ['get', 'post'] as const) {
        const res = await pub(
          api()[verb](`/api/v1/public/weekly-digest-unsubscribe/${token}`),
          other.host,
        ).expect(404);
        expect((res.body as { message: string }).message).toBe(
          WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE,
        );
        await pub(
          api()[verb](
            `/api/v1/public/weekly-digest-unsubscribe/${'Z'.repeat(43)}`,
          ),
        ).expect(404);
        await pub(
          api()[verb]('/api/v1/public/weekly-digest-unsubscribe/corto'),
        ).expect(404);
      }
      expect(await recipientRows()).toBe(1);
    });

    it('el POST da de baja una vez, lo audita con la persona del enlace y repetirlo responde lo mismo', async () => {
      const first = await pub(
        api().post(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(200);
      expect(first.body).toEqual({
        clinicName: 'Clinica dx568-e2e',
        status: 'ALREADY_OUT',
      });
      expect(first.headers['cache-control']).toContain('no-store');
      expect(await recipientRows()).toBe(0);
      const delivery = await raw.weeklyDigestDelivery.findFirstOrThrow({
        where: { membershipId: ownerMembershipId },
      });
      expect(delivery.usedAt).not.toBeNull();

      await pub(
        api().post(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(200, { clinicName: 'Clinica dx568-e2e', status: 'ALREADY_OUT' });
      await pub(
        api().get(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(200, { clinicName: 'Clinica dx568-e2e', status: 'ALREADY_OUT' });

      const out = (await digestEvents()).filter(
        (e) =>
          (e.metadata as { reason: string }).reason ===
          'WEEKLY_DIGEST_UNSUBSCRIBED',
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        action: 'UPDATE',
        actorUserId: clinic.adminUserId,
        actorRole: 'ADMIN',
        resourceId: clinic.tenantId,
        locationId: null,
        metadata: {
          reason: 'WEEKLY_DIGEST_UNSUBSCRIBED',
          origin: 'LINK',
          changedFields: ['recipientMembershipIds'],
        },
      });
      // Ajustes ya no lo lista; volver a marcarlo lo devuelve.
      const settings = (await getSettings().expect(200)).body as SettingsBody;
      expect(settings.recipientMembershipIds).toEqual([admin2.membershipId]);
    });

    it('un enlace caducado (60 días) es 404', async () => {
      // La guarda congela la caducidad (y la entrega ya está usada): el test
      // la mueve como owner con los triggers apagados.
      await raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.weeklyDigestDelivery.updateMany({
          where: { membershipId: ownerMembershipId },
          data: {
            expiresAt: new Date(Date.now() - 1000),
            createdAt: new Date(Date.now() - 2000),
          },
        });
      });
      await pub(
        api().get(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(404);
      await pub(
        api().post(`/api/v1/public/weekly-digest-unsubscribe/${token}`),
      ).expect(404);
    });
  });
});
