import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  FOLLOW_UP_ALREADY_PAUSED_MESSAGE,
  FOLLOW_UP_NOT_OPEN_MESSAGE,
  FOLLOW_UP_NOT_PAUSED_MESSAGE,
  FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE,
} from '../src/modules/quote-follow-up/application/quote-follow-up-pause.use-cases';
import {
  FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE,
  FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE,
} from '../src/modules/quote-follow-up/application/quote-follow-up-report.use-case';
import {
  OFFSET_RANGE_MESSAGE,
  OFFSETS_COUNT_MESSAGE,
  OFFSETS_ORDER_MESSAGE,
  UNTIL_HOUR_MESSAGE,
  WINDOW_ORDER_MESSAGE,
} from '../src/modules/quote-follow-up/domain/quote-follow-up-settings';
import { QUOTE_FOLLOW_UP_REPORT_FORBIDDEN_MESSAGE } from '../src/modules/quote-follow-up/presentation/quote-follow-up-report.controller';
import { QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/quote-follow-up/presentation/quote-follow-up-settings.controller';
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  caracas,
  quoteFunnelSeeding,
  type FunnelClinic,
} from './support/quote-funnel-fixtures';

// DX-561 por HTTP contra Postgres: Ajustes › Presupuestos › Seguimiento
// automático (solo ADMIN, validación en español, auditado con el antes y el
// después en la sede y sin evento si nada cambia), pausar y reanudar desde
// «Presupuestos por seguir» (ADMIN y RECEPTION, auditado, 409 en español),
// `followUp` en la lista y el informe de efectividad (alcance del embudo).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface SettingsRow {
  locationId: string;
  locationName: string;
  enabled: boolean;
  offsetsDays: number[];
  sendFromHour: number;
  sendUntilHour: number;
  updatedAt: string | null;
}

describe('Seguimiento automático de presupuestos (e2e, DX-561)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let locationId: string;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let assistant: { userId: string; token: string };
  const seed = quoteFunnelSeeding(raw);
  let funnel: FunnelClinic;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const putSettings = (
    body: object,
    token = clinic.adminToken,
    id = locationId,
  ) =>
    as(api().put(`/api/v1/quote-follow-up-settings/${id}`), token).send(body);
  const pause = (planId: string, token = reception.token) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/follow-up/pause`), token);
  const resume = (planId: string, token = reception.token) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/follow-up/resume`), token);
  const report = (query: string, token = clinic.adminToken) =>
    as(api().get(`/api/v1/reports/quote-follow-up?${query}`), token);

  async function member(role: ClinicRole) {
    const m = await seedMember(raw, clinic, role);
    return {
      userId: m.userId,
      token: await loginAs(app, clinic.host, m.email),
    };
  }

  /** Un presupuesto presentado hace 3 días (A/B si `options` = 2). */
  async function presented(
    options = 1,
    status: 'PRESENTED' | 'ACCEPTED' = 'PRESENTED',
  ) {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Ana',
        lastName: `Seguimiento e2e ${Math.random().toString(36).slice(2, 8)}`,
        email: `ana-${Math.random().toString(36).slice(2, 8)}@seguimiento.test`,
      },
    });
    const today = fixedSedeDay(0).day;
    const root = await seed.plan(
      { ...funnel, patientId: patient.id },
      {
        status,
        presentedAt: caracas(addCivilDays(today, -3), '10:00'),
        patientId: patient.id,
        items: [{ price: 120 }],
      },
    );
    const ids = [root.id];
    for (let i = 1; i < options; i++) {
      const alt = await seed.plan(
        { ...funnel, patientId: patient.id },
        {
          status: 'PRESENTED',
          presentedAt: caracas(addCivilDays(today, -3), '10:05'),
          patientId: patient.id,
          optionGroupId: root.id,
          items: [{ price: 220 }],
        },
      );
      ids.push(alt.id);
    }
    if (options > 1) {
      await seed.withoutTriggers((tx) =>
        tx.treatmentPlan.update({
          where: { id: root.id },
          data: { optionGroupId: root.id },
        }),
      );
    }
    return { patientId: patient.id, planIds: ids };
  }

  const configEvents = async () =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'CLINIC_SETTINGS' },
        orderBy: { occurredAt: 'asc' },
      })
    ).filter(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'QUOTE_FOLLOW_UP_SETTINGS_UPDATED',
    );

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx561-e2e');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    funnel = {
      tenantId: clinic.tenantId,
      main: locationId,
      norte: locationId,
      patientId: '',
      dentist: { id: '', userId: dentist.userId },
      otherDentistId: '',
    } as unknown as FunnelClinic;
  });

  afterAll(async () => {
    await app?.close();
    await raw.$disconnect();
  });

  describe('ajustes por sede', () => {
    it('GET: cada sede viva, sin configurar = apagado con 3/10/21 de 9 a 19', async () => {
      const res = await as(
        api().get('/api/v1/quote-follow-up-settings'),
      ).expect(200);
      const rows = res.body as SettingsRow[];
      expect(rows.find((r) => r.locationId === locationId)).toEqual({
        locationId,
        locationName: expect.any(String) as string,
        enabled: false,
        offsetsDays: [3, 10, 21],
        sendFromHour: 9,
        sendUntilHour: 19,
        updatedAt: null,
      });
    });

    it('solo ADMIN: los demás roles reciben 403 en español', async () => {
      for (const m of [dentist, reception, assistant]) {
        const res = await as(
          api().get('/api/v1/quote-follow-up-settings'),
          m.token,
        ).expect(403);
        expect((res.body as { message: string }).message).toBe(
          QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE,
        );
        await putSettings(
          {
            enabled: true,
            offsetsDays: [3],
            sendFromHour: 9,
            sendUntilHour: 19,
          },
          m.token,
        ).expect(403);
      }
    });

    it.each([
      [{ offsetsDays: [] }, OFFSETS_COUNT_MESSAGE],
      [{ offsetsDays: [1, 2, 3, 4] }, OFFSETS_COUNT_MESSAGE],
      [{ offsetsDays: [0] }, OFFSET_RANGE_MESSAGE],
      [{ offsetsDays: [91] }, OFFSET_RANGE_MESSAGE],
      [{ offsetsDays: [10, 3] }, OFFSETS_ORDER_MESSAGE],
      [{ sendUntilHour: 25 }, UNTIL_HOUR_MESSAGE],
      [{ sendFromHour: 19, sendUntilHour: 9 }, WINDOW_ORDER_MESSAGE],
    ])('PUT %j → 400 «%s»', async (patch, message) => {
      const res = await putSettings({
        enabled: true,
        offsetsDays: [3, 10, 21],
        sendFromHour: 9,
        sendUntilHour: 19,
        ...patch,
      }).expect(400);
      const body = res.body as { message: string | string[] };
      expect([body.message].flat()).toContain(message);
    });

    it('PUT con un id que no es uuid: 400 en español', async () => {
      const res = await putSettings(
        { enabled: true, offsetsDays: [3], sendFromHour: 9, sendUntilHour: 19 },
        clinic.adminToken,
        'no-es-un-uuid',
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El identificador de la sede no es válido.',
      );
    });

    it('PUT: guarda, audita el antes y el después en la sede y no deja evento si nada cambia', async () => {
      const body = {
        enabled: true,
        offsetsDays: [2, 7, 30],
        sendFromHour: 8,
        sendUntilHour: 20,
      };
      const res = await putSettings(body).expect(200);
      expect(res.body).toMatchObject({ locationId, ...body });
      expect((res.body as SettingsRow).updatedAt).not.toBeNull();
      const [event] = await configEvents();
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceId: locationId,
        locationId,
        actorUserId: clinic.adminUserId,
        metadata: {
          reason: 'QUOTE_FOLLOW_UP_SETTINGS_UPDATED',
          configChange: {
            before: {
              enabled: false,
              offsetsDays: [3, 10, 21],
              sendFromHour: 9,
              sendUntilHour: 19,
            },
            after: body,
          },
        },
      });
      await putSettings(body).expect(200);
      expect(await configEvents()).toHaveLength(1);
      const list = await as(
        api().get('/api/v1/quote-follow-up-settings'),
      ).expect(200);
      expect(
        (list.body as SettingsRow[]).find((r) => r.locationId === locationId),
      ).toMatchObject(body);
    });

    it('PUT de una sede que no existe: 404 «Sede no encontrada»', async () => {
      const res = await putSettings(
        { enabled: true, offsetsDays: [3], sendFromHour: 9, sendUntilHour: 19 },
        clinic.adminToken,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Sede no encontrada',
      );
    });
  });

  describe('pausar y reanudar', () => {
    it('RECEPTION pausa todo el grupo, queda auditado y la lista lo dice; otra vez es 409', async () => {
      const g = await presented(2);
      const res = await pause(g.planIds[1]).expect(200);
      expect(res.body).toMatchObject({
        planId: g.planIds[1],
        groupId: g.planIds[0],
        paused: true,
        pausedById: reception.userId,
      });
      const plans = await raw.treatmentPlan.findMany({
        where: { id: { in: g.planIds } },
        select: { quoteFollowUpPausedAt: true, quoteFollowUpPausedById: true },
      });
      expect(
        plans.every((p) => p.quoteFollowUpPausedById === reception.userId),
      ).toBe(true);
      const [event] = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'TREATMENT_PLAN',
          resourceId: g.planIds[1],
          action: 'UPDATE',
        },
      });
      expect(event).toMatchObject({
        actorUserId: reception.userId,
        patientId: g.patientId,
        metadata: expect.objectContaining({
          reason: 'QUOTE_FOLLOW_UP_PAUSED',
        }) as object,
      });
      const again = await pause(g.planIds[0]).expect(409);
      expect((again.body as { message: string }).message).toBe(
        FOLLOW_UP_ALREADY_PAUSED_MESSAGE,
      );

      const list = await as(
        api().get(
          '/api/v1/treatment-plans/pending-follow-up?olderThanDays=0&pageSize=100',
        ),
        reception.token,
      ).expect(200);
      const items = (
        list.body as {
          items: {
            planId: string;
            followUp: { paused: boolean; lastStep: number | null };
          }[];
        }
      ).items.filter((i) => g.planIds.includes(i.planId));
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.followUp).toEqual({
          lastStep: null,
          lastSentAt: null,
          lastStatus: null,
          lastReason: null,
          paused: true,
        });
      }

      const resumed = await resume(g.planIds[0], clinic.adminToken).expect(200);
      expect(resumed.body).toMatchObject({ paused: false, pausedAt: null });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'TREATMENT_PLAN',
          resourceId: g.planIds[0],
          action: 'UPDATE',
        },
      });
      expect(
        events.map((e) => (e.metadata as { reason?: string }).reason),
      ).toContain('QUOTE_FOLLOW_UP_RESUMED');
      const twice = await resume(g.planIds[0], clinic.adminToken).expect(409);
      expect((twice.body as { message: string }).message).toBe(
        FOLLOW_UP_NOT_PAUSED_MESSAGE,
      );
    });

    it('DENTIST y ASSISTANT no pausan (403); un plan aceptado es 409 y uno que no existe, 404', async () => {
      const g = await presented();
      await pause(g.planIds[0], dentist.token).expect(403);
      await pause(g.planIds[0], assistant.token).expect(403);
      await resume(g.planIds[0], assistant.token).expect(403);
      const accepted = await presented(1, 'ACCEPTED');
      const res = await pause(accepted.planIds[0]).expect(409);
      expect((res.body as { message: string }).message).toBe(
        FOLLOW_UP_NOT_OPEN_MESSAGE,
      );
      const missing = await pause(
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
      expect((missing.body as { message: string }).message).toBe(
        FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE,
      );
    });
  });

  describe('informe de efectividad', () => {
    const today = fixedSedeDay(0).day;
    const range = `from=${addCivilDays(today, -30)}&to=${today}`;

    it('ADMIN ve la clínica; DENTIST, lo suyo; RECEPTION y ASSISTANT, 403', async () => {
      const admin = await report(range).expect(200);
      expect(admin.body).toMatchObject({
        scope: 'CLINIC',
        restrictedToLocations: false,
        filters: { locationId: null },
        total: { step: null, sent: 0, acceptanceRate: null },
        skipped: [],
      });
      const body = admin.body as {
        steps: { step: number }[];
        definitions: { key: string }[];
      };
      expect(body.steps.map((s) => s.step)).toEqual([1, 2, 3]);
      expect(body.definitions.map((d) => d.key)).toEqual([
        'sent',
        'opened',
        'acceptedWithin14Days',
        'acceptanceRate',
        'skipped',
      ]);
      const own = await report(range, dentist.token).expect(200);
      expect(own.body).toMatchObject({ scope: 'OWN' });
      for (const m of [reception, assistant]) {
        const res = await report(range, m.token).expect(403);
        expect((res.body as { message: string }).message).toBe(
          QUOTE_FOLLOW_UP_REPORT_FORBIDDEN_MESSAGE,
        );
      }
    });

    it('un período inválido o demasiado largo: 400 en español; una sede: el filtro', async () => {
      const bad = await report(
        `from=${today}&to=${addCivilDays(today, -1)}`,
      ).expect(400);
      expect((bad.body as { message: string }).message).toBe(
        FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE,
      );
      const long = await report(
        `from=${addCivilDays(today, -400)}&to=${today}`,
      ).expect(400);
      expect((long.body as { message: string }).message).toBe(
        FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE,
      );
      const one = await report(`${range}&locationId=${locationId}`).expect(200);
      expect(one.body).toMatchObject({ filters: { locationId } });
    });
  });
});
