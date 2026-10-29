import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import { TokenService } from '../src/shared/crypto/token.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../src/shared/tenancy/location-access';
import type { LocationsComparison } from '../src/modules/reports/application/use-cases/get-locations-comparison.use-case';
import {
  ATTRIBUTION_ADMIN_ONLY_MESSAGE,
  COMPLETED_AT_BY_SERVER_MESSAGE,
  PERFORMED_LOCATION_NOT_FOUND_MESSAGE,
  UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE,
  PERFORMER_NOT_AT_LOCATION_MESSAGE,
  PERFORMER_NOT_ATTENDING_MESSAGE,
  PERFORMER_NOT_FOUND_MESSAGE,
  PERFORMER_REQUIRED_MESSAGE,
  REVERT_DONE_FORBIDDEN_MESSAGE,
} from '../src/modules/treatment-plans/domain/plan-item-attribution';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

/**
 * DX-050 · Producción atribuible: quién realizó cada ítem del plan, dónde y
 * cuándo. Marcar DONE exige un profesional que atiende (por defecto quien
 * marca, si atiende), toma la sede de `X-Location-Id` y la hora del servidor;
 * un profesional de otra clínica no existe (404); solo un ADMIN corrige quién
 * o cuándo (auditado); salir de DONE limpia la atribución (auditado).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwords = new PasswordService();

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Item {
  id: string;
  status: string;
  performedById: string | null;
  performedByName: string | null;
  performedLocationId: string | null;
  performedLocationName: string | null;
  completedAt: string | null;
}

interface Member {
  userId: string;
  token: string;
}

describe('DX-050 · ítem realizado con profesional, sede y hora (e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: Member;
  let dentistNorte: Member;
  let assistant: Member;
  let reception: { userId: string };
  let dentistB: { userId: string };
  let mainLocationId: string;
  let norteLocationId: string;
  let patientId: string;
  let catalogItemId: string;
  let planId: string;

  function api(
    verb: Verb,
    path: string,
    token: string,
    body?: object,
    locationId?: string,
  ): request.Test {
    let req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${token}`);
    if (locationId) req = req.set('X-Location-Id', locationId);
    return body === undefined ? req : req.send(body);
  }

  async function newItem(tooth: string): Promise<string> {
    const res = await api(
      'post',
      `/treatment-plans/${planId}/items`,
      a.adminToken,
      {
        toothNumber: tooth,
        catalogItemId,
        price: 100,
      },
    ).expect(201);
    const id = (res.body as Item).id;
    await api('patch', `/treatment-plans/${planId}/items/${id}`, a.adminToken, {
      status: 'ACCEPTED',
    }).expect(200);
    return id;
  }

  function patchItem(
    id: string,
    token: string,
    body: object,
    locationId?: string,
  ): request.Test {
    return api(
      'patch',
      `/treatment-plans/${planId}/items/${id}`,
      token,
      body,
      locationId,
    );
  }

  /** Miembro de A con su token (`email` distinto para un segundo del mismo rol). */
  async function member(role: ClinicRole, name?: string): Promise<Member> {
    const email = `${name ?? role.toLowerCase()}@${a.subdomain}.test`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(SEEDED_PASSWORD),
        fullName: `Miembro ${name ?? role}`,
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: user.id, role },
    });
    return { userId: user.id, token: await loginAs(app, a.host, email) };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx050-a');
    b = await registerClinic(app, 'dx050-b');
    dentist = await member(ClinicRole.DENTIST);
    dentistNorte = await member(ClinicRole.DENTIST, 'dentista-norte');
    assistant = await member(ClinicRole.ASSISTANT);
    reception = await seedMember(raw, a, ClinicRole.RECEPTION);
    dentistB = await seedMember(raw, b, ClinicRole.DENTIST);
    await raw.user.update({
      where: { id: dentist.userId },
      data: { fullName: 'Dra. Laura Gómez' },
    });

    const locations = await api('get', '/locations', a.adminToken).expect(200);
    mainLocationId = (locations.body as { id: string }[])[0].id;
    const norte = await api(
      'post',
      '/locations',
      a.adminToken,
      locationBody(REGIONAL_BOGOTA_FIXTURE, {
        name: 'Sede Norte',
      }),
    ).expect(201);
    norteLocationId = (norte.body as { id: string }).id;
    await api('put', `/staff/${dentistNorte.userId}/locations`, a.adminToken, {
      locationIds: [norteLocationId],
    }).expect(200);
    // El token del restringido se emite después de restringirlo.
    dentistNorte.token = await loginAs(
      app,
      a.host,
      `dentista-norte@${a.subdomain}.test`,
    );

    const patient = await api('post', '/patients', a.adminToken, {
      firstName: 'Ana',
      lastName: 'Ruiz',
      docType: 'NATIONAL_ID',
      docNumber: '5050',
      sex: Sex.F,
    }).expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await api('post', '/catalog/items', a.adminToken, {
      code: 'RESINA-050',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Resina',
      color: '#2A2B3C',
      defaultPrice: 100,
    }).expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
    const plan = await api(
      'post',
      `/patients/${patientId}/treatment-plans`,
      a.adminToken,
      { currency: 'USD' },
    ).expect(201);
    planId = (plan.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('un DENTIST marca DONE: queda él, la sede de X-Location-Id y la hora del servidor; el odontograma lo firma él', async () => {
    const id = await newItem('11');
    const before = Date.now();
    const res = await patchItem(
      id,
      dentist.token,
      { status: 'DONE' },
      mainLocationId,
    ).expect(200);
    const item = res.body as Item;
    expect(item).toMatchObject({
      status: 'DONE',
      performedById: dentist.userId,
      performedByName: 'Dra. Laura Gómez',
      performedLocationId: mainLocationId,
    });
    expect(item.performedLocationName).toEqual(expect.any(String));
    expect(new Date(item.completedAt!).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    const record = await raw.toothRecord.findFirstOrThrow({
      where: { sourcePlanItemId: id },
    });
    expect(record.performedById).toBe(dentist.userId);

    // La ficha del plan lo muestra.
    const detail = await api(
      'get',
      `/treatment-plans/${planId}`,
      a.adminToken,
    ).expect(200);
    expect(
      (detail.body as { items: Item[] }).items.find((i) => i.id === id),
    ).toMatchObject({
      performedById: dentist.userId,
      performedByName: 'Dra. Laura Gómez',
      performedLocationId: mainLocationId,
    });
  });

  it('la asistente sin performedById → 400 en español y nada cambia', async () => {
    const id = await newItem('12');
    const res = await patchItem(id, assistant.token, { status: 'DONE' }).expect(
      400,
    );
    expect((res.body as { message: string }).message).toBe(
      PERFORMER_REQUIRED_MESSAGE,
    );
    const row = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id },
    });
    expect(row).toMatchObject({ status: 'ACCEPTED', performedById: null });
    expect(
      await raw.toothRecord.count({ where: { sourcePlanItemId: id } }),
    ).toBe(0);
  });

  it('la asistente indica la dentista: el odontograma lo firma la dentista; la sede, la de la cabecera', async () => {
    const id = await newItem('13');
    const res = await patchItem(
      id,
      assistant.token,
      { status: 'DONE', performedById: dentist.userId },
      norteLocationId,
    ).expect(200);
    expect(res.body).toMatchObject({
      performedById: dentist.userId,
      performedLocationId: norteLocationId,
      performedLocationName: 'Sede Norte',
    });
    const record = await raw.toothRecord.findFirstOrThrow({
      where: { sourcePlanItemId: id },
    });
    expect(record.performedById).toBe(dentist.userId);
  });

  it('sin X-Location-Id (vista consolidada) la sede es la de escritura: la principal', async () => {
    const id = await newItem('14');
    const res = await patchItem(id, a.adminToken, { status: 'DONE' }).expect(
      200,
    );
    expect(res.body).toMatchObject({
      performedById: a.adminUserId,
      performedLocationId: mainLocationId,
    });
  });

  it.each([
    ['ASSISTANT', () => assistant.userId],
    ['RECEPTION', () => reception.userId],
  ])(
    'un %s no puede figurar como quien lo realizó → 400',
    async (_role, userId) => {
      const id = await newItem(_role === 'ASSISTANT' ? '15' : '16');
      const res = await patchItem(id, a.adminToken, {
        status: 'DONE',
        performedById: userId(),
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PERFORMER_NOT_ATTENDING_MESSAGE,
      );
    },
  );

  it('un profesional de OTRA clínica → 404 y el ítem sigue aceptado', async () => {
    const id = await newItem('17');
    const res = await patchItem(id, a.adminToken, {
      status: 'DONE',
      performedById: dentistB.userId,
    }).expect(404);
    expect((res.body as { message: string }).message).toBe(
      PERFORMER_NOT_FOUND_MESSAGE,
    );
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'ACCEPTED', performedById: null });
  });

  it('un profesional restringido a otra sede → 400', async () => {
    const id = await newItem('18');
    const res = await patchItem(
      id,
      a.adminToken,
      { status: 'DONE', performedById: dentistNorte.userId },
      mainLocationId,
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      PERFORMER_NOT_AT_LOCATION_MESSAGE,
    );
    await patchItem(
      id,
      a.adminToken,
      { status: 'DONE', performedById: dentistNorte.userId },
      norteLocationId,
    ).expect(200);
  });

  it('completedAt al marcar DONE → 400 (lo pone el servidor)', async () => {
    const id = await newItem('21');
    const res = await patchItem(id, a.adminToken, {
      status: 'DONE',
      completedAt: '2026-10-01T10:00:00.000Z',
    }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      COMPLETED_AT_BY_SERVER_MESSAGE,
    );
  });

  describe('ítem ya realizado', () => {
    let id: string;

    beforeAll(async () => {
      id = await newItem('22');
      await patchItem(
        id,
        dentist.token,
        { status: 'DONE' },
        mainLocationId,
      ).expect(200);
    });

    it.each([
      ['DENTIST', () => dentist.token],
      ['ASSISTANT', () => assistant.token],
    ])('un %s no cambia quién lo realizó → 403', async (_role, token) => {
      const res = await patchItem(id, token(), {
        performedById: a.adminUserId,
      }).expect(403);
      expect((res.body as { message: string }).message).toBe(
        ATTRIBUTION_ADMIN_ONLY_MESSAGE,
      );
    });

    it('un ADMIN cambia quién y cuándo, y queda en la auditoría con el antes y el después', async () => {
      const before = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id },
      });
      const completedAt = '2026-10-20T15:00:00.000Z';
      const res = await patchItem(id, a.adminToken, {
        performedById: a.adminUserId,
        completedAt,
      }).expect(200);
      expect(res.body).toMatchObject({
        performedById: a.adminUserId,
        performedByName: 'Dr. Owner',
        performedLocationId: mainLocationId,
        completedAt,
      });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          metadata: {
            path: ['reason'],
            equals: 'PLAN_ITEM_ATTRIBUTION_CORRECTED',
          },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: a.adminUserId,
        actorRole: 'ADMIN',
        patientId,
        metadata: {
          reason: 'PLAN_ITEM_ATTRIBUTION_CORRECTED',
          attribution: {
            before: {
              performedById: dentist.userId,
              locationId: mainLocationId,
              completedAt: before.completedAt!.toISOString(),
            },
            after: {
              performedById: a.adminUserId,
              locationId: mainLocationId,
              completedAt,
            },
          },
        },
      });
    });

    it('una dentista que no lo realizó no lo saca de DONE → 403', async () => {
      const res = await patchItem(id, dentist.token, {
        status: 'ACCEPTED',
      }).expect(403);
      expect((res.body as { message: string }).message).toBe(
        REVERT_DONE_FORBIDDEN_MESSAGE,
      );
    });

    it('un ADMIN lo devuelve a aceptado: la atribución se limpia y queda auditada', async () => {
      const res = await patchItem(id, a.adminToken, {
        status: 'ACCEPTED',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'ACCEPTED',
        performedById: null,
        performedByName: null,
        performedLocationId: null,
        completedAt: null,
      });
      const [event] = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          metadata: { path: ['reason'], equals: 'PLAN_ITEM_DONE_REVERTED' },
        },
      });
      expect(event.metadata).toMatchObject({
        attribution: {
          before: { performedById: a.adminUserId },
          after: { performedById: null, locationId: null, completedAt: null },
        },
      });
    });
  });

  it('quien lo realizó puede deshacer su propio «Realizado»', async () => {
    const id = await newItem('23');
    await patchItem(id, dentist.token, { status: 'DONE' }).expect(200);
    await patchItem(id, dentist.token, { status: 'ACCEPTED' }).expect(200);
  });

  it('en un plan completado, un ADMIN corrige quién lo realizó', async () => {
    const plan = await api(
      'post',
      `/patients/${patientId}/treatment-plans`,
      a.adminToken,
      { currency: 'USD' },
    ).expect(201);
    const closedPlanId = (plan.body as { id: string }).id;
    const item = await api(
      'post',
      `/treatment-plans/${closedPlanId}/items`,
      a.adminToken,
      { toothNumber: '24', catalogItemId, price: 100 },
    ).expect(201);
    const itemId = (item.body as Item).id;
    const patch = (body: object, token = a.adminToken) =>
      api(
        'patch',
        `/treatment-plans/${closedPlanId}/items/${itemId}`,
        token,
        body,
      );
    await api('patch', `/treatment-plans/${closedPlanId}`, a.adminToken, {
      status: 'ACCEPTED',
    }).expect(200);
    await patch({ status: 'DONE' }, dentist.token).expect(200);
    await api('patch', `/treatment-plans/${closedPlanId}`, a.adminToken, {
      status: 'COMPLETED',
    }).expect(200);

    await patch({ performedById: a.adminUserId }).expect(200);
    await patch({ performedById: dentist.userId, notes: 'x' }).expect(409);
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id: itemId } }),
    ).toMatchObject({ performedById: a.adminUserId, notes: null });
  });

  it('un DONE anterior a DX-050 sale «Sin atribuir» (todo null)', async () => {
    const id = await newItem('25');
    // Lo que dejó la migración: DONE sin atribución (sin pasar por la API).
    await raw.treatmentPlanItem.update({
      where: { id },
      data: { status: 'DONE' },
    });
    const detail = await api(
      'get',
      `/treatment-plans/${planId}`,
      a.adminToken,
    ).expect(200);
    expect(
      (detail.body as { items: Item[] }).items.find((i) => i.id === id),
    ).toMatchObject({
      status: 'DONE',
      performedById: null,
      performedByName: null,
      performedLocationId: null,
      performedLocationName: null,
      completedAt: null,
    });
  });
  describe('DX-305 · atribuir un «Sin atribuir» exige la sede', () => {
    let id: string;
    const completedAt = '2026-09-14T15:00:00.000Z';
    const unattributed = () =>
      raw.treatmentPlanItem.update({
        where: { id },
        data: { status: 'DONE' },
      });

    beforeAll(async () => {
      id = await newItem('27');
      await unattributed();
    });

    it('sin sede (o sin quién o cuándo) → 400 en español y nada cambia', async () => {
      for (const body of [
        { performedById: dentistNorte.userId },
        { performedById: dentistNorte.userId, completedAt },
        { performedLocationId: norteLocationId, completedAt },
      ]) {
        const res = await patchItem(id, a.adminToken, body).expect(400);
        expect((res.body as { message: string }).message).toBe(
          UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE,
        );
      }
      expect(
        await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ performedById: null, performedLocationId: null });
    });

    const full = () => ({
      performedById: dentistNorte.userId,
      completedAt,
      performedLocationId: norteLocationId,
    });

    it('solo un ADMIN lo atribuye → 403 a un DENTIST', async () => {
      const res = await patchItem(id, dentist.token, full()).expect(403);
      expect((res.body as { message: string }).message).toBe(
        ATTRIBUTION_ADMIN_ONLY_MESSAGE,
      );
    });

    it('una sede fuera de las permitidas al ADMIN → 403 (DX-089)', async () => {
      // DX-089 no deja restringir a un ADMIN (409); se firma el token igual
      // que en «Comparar sedes».
      const restricted = (
        await app.get(TokenService).issue({
          sub: a.adminUserId,
          tenantId: a.tenantId,
          role: ClinicRole.ADMIN,
          loc: [mainLocationId],
          tv: 0,
        })
      ).accessToken;
      const res = await patchItem(id, restricted, full()).expect(403);
      expect((res.body as { message: string }).message).toBe(
        LOCATION_NOT_ALLOWED_MESSAGE,
      );
    });

    it('una sede de otra clínica → 400', async () => {
      const [other] = await raw.location.findMany({
        where: { tenantId: b.tenantId },
        select: { id: true },
      });
      const res = await patchItem(id, a.adminToken, {
        ...full(),
        performedLocationId: other.id,
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PERFORMED_LOCATION_NOT_FOUND_MESSAGE,
      );
    });

    it('un profesional que no atiende en esa sede → 400', async () => {
      const res = await patchItem(id, a.adminToken, {
        ...full(),
        performedLocationId: mainLocationId,
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PERFORMER_NOT_AT_LOCATION_MESSAGE,
      );
    });

    it('un ADMIN lo atribuye con quién, cuándo y sede: auditado y entra en «Comparar sedes»', async () => {
      const res = await patchItem(id, a.adminToken, full()).expect(200);
      expect(res.body).toMatchObject({
        performedById: dentistNorte.userId,
        performedLocationId: norteLocationId,
        performedLocationName: 'Sede Norte',
        completedAt,
      });
      const [event] = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          metadata: {
            path: ['reason'],
            equals: 'PLAN_ITEM_ATTRIBUTION_CORRECTED',
          },
        },
      });
      expect(event).toMatchObject({
        actorUserId: a.adminUserId,
        metadata: {
          attribution: {
            before: {
              performedById: null,
              locationId: null,
              completedAt: null,
            },
            after: {
              performedById: dentistNorte.userId,
              locationId: norteLocationId,
              completedAt,
            },
          },
        },
      });
      const report = await api(
        'get',
        '/reports/locations-comparison?from=2026-09-14&to=2026-09-14&compare=none',
        a.adminToken,
      ).expect(200);
      const norte = (report.body as LocationsComparison).locations.find(
        (l) => l.locationId === norteLocationId,
      );
      expect(norte?.metrics.production).toEqual([
        {
          currency: 'USD',
          value: 100,
          previous: null,
          change: null,
          trend: null,
        },
      ]);
    });

    it('después, un ADMIN corrige solo la sede (y quien lo realizó tiene que atender allí)', async () => {
      await patchItem(id, a.adminToken, {
        performedLocationId: mainLocationId,
      }).expect(400);
      await patchItem(id, a.adminToken, {
        performedById: dentist.userId,
        performedLocationId: mainLocationId,
      }).expect(200);
      expect(
        await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        performedById: dentist.userId,
        performedLocationId: mainLocationId,
        completedAt: new Date(completedAt),
      });
    });
  });
});
