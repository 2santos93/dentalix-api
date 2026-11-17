import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import { safeTodayZone } from './support/sede-clock';
import { TokenService } from '../src/shared/crypto/token.service';
import { civilDateIn } from '../src/shared/time/civil-day';
import type {
  PostOpCheckCountView,
  PostOpCheckList,
} from '../src/modules/post-op-checks/application/post-op-checks.use-cases';
import { POST_OP_MESSAGES } from '../src/modules/post-op-checks/domain/post-op-check-rules';
import type { WorkQueuesSummary } from '../src/modules/work-queues/domain/work-queues';

/**
 * DX-566 · Control postoperatorio por HTTP real. Clínica A (zona de
 * `safeTodayZone`) con la sede principal y la Norte; la clínica B, para el
 * aislamiento. El control nace del PATCH real del ítem a DONE (la extracción
 * del catálogo pide control a 1 día); para que salga en la lista de hoy, `raw`
 * (owner) le pone hoy como día de la llamada (la guarda deja cambiar la fecha
 * de un PENDING).
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = safeTodayZone();
const ROUTE = '/post-op-checks';

describe('Control postoperatorio (DX-566, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let receptionOnlyNorte: string;
  let patient: string;
  let catalogId: string;
  let planId: string;

  const api = (clinic: Clinic, token: string, location?: string) => {
    const withHeaders = (req: request.Test) => {
      const r = req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return location ? r.set('X-Location-Id', location) : r;
    };
    return {
      get: (path: string, query: object = {}) =>
        withHeaders(
          request(app.getHttpServer()).get(`/api/v1${path}`).query(query),
        ),
      post: (path: string, body: object) =>
        withHeaders(
          request(app.getHttpServer()).post(`/api/v1${path}`).send(body),
        ),
      patch: (path: string, body: object) =>
        withHeaders(
          request(app.getHttpServer()).patch(`/api/v1${path}`).send(body),
        ),
    };
  };

  const list = async (token: string, query: object = {}) =>
    (await api(a, token).get(ROUTE, query).expect(200)).body as PostOpCheckList;
  const count = async (token: string, query: object = {}) =>
    (await api(a, token).get(`${ROUTE}/count`, query).expect(200))
      .body as PostOpCheckCountView;

  /** Un ítem ACEPTADO de la extracción, marcado DONE por el PATCH real. */
  async function doneExtraction(locationId: string): Promise<string> {
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId,
        toothNumber: '38',
        catalogItemId: catalogId,
        price: 40,
        status: 'ACCEPTED',
      },
    });
    await api(a, a.adminToken, locationId)
      .patch(`/treatment-plans/${planId}/items/${item.id}`, {
        status: 'DONE',
        performedById: a.adminUserId,
      })
      .expect(200);
    const check = await raw.postOpCheck.findFirstOrThrow({
      where: { planItemId: item.id },
    });
    // Que toque llamar hoy (en la zona de la sede).
    await raw.postOpCheck.update({
      where: { id: check.id },
      data: {
        dueOn: new Date(`${civilDateIn(new Date(), ZONE)}T00:00:00.000Z`),
      },
    });
    return check.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'postop-a');
    b = await registerClinic(app, 'postop-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    await raw.location.updateMany({
      where: { tenantId: a.tenantId },
      data: { timeZone: ZONE },
    });
    patient = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Luisa',
          lastName: 'Postop',
          phone: '0414-123-4567',
        },
      })
    ).id;
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.RECEPTION) {
        receptionOnlyNorte = (
          await app.get(TokenService).issue({
            sub: member.userId,
            tenantId: a.tenantId,
            role: ClinicRole.RECEPTION,
            loc: [norte],
            tv: 0,
          })
        ).accessToken;
      }
    }
    // La extracción del catálogo, sin control; el PATCH real se lo activa.
    catalogId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: a.tenantId,
          code: 'CIR-EXO-566',
          kind: 'PROCEDURE',
          labelEs: 'Extracción simple',
          color: '#0E7490',
        },
      })
    ).id;
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient,
          currency: 'USD',
          status: 'ACCEPTED',
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('catálogo (D1)', () => {
    it('ADMIN activa «Pide control postoperatorio» con sus días; se lee en el catálogo', async () => {
      const res = await api(a, a.adminToken)
        .patch(`/catalog/items/${catalogId}`, {
          requiresPostOpCheck: true,
          postOpCheckAfterDays: 1,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        requiresPostOpCheck: true,
        postOpCheckAfterDays: 1,
      });
    });

    it('días fuera de 1–30: 400 en español', async () => {
      const res = await api(a, a.adminToken)
        .patch(`/catalog/items/${catalogId}`, { postOpCheckAfterDays: 31 })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'Los días del control postoperatorio van de 1 a 30.',
      );
    });

    it('un diagnóstico no lo pide: 400', async () => {
      const res = await api(a, a.adminToken)
        .post('/catalog/items', {
          code: 'DX-566-DIAG',
          kind: 'DIAGNOSIS',
          labelEs: 'Alveolitis',
          color: '#AA0000',
          requiresPostOpCheck: true,
        })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Solo un procedimiento puede pedir control postoperatorio.',
      );
    });
  });

  describe('lista, roles y sede (D5)', () => {
    let checkId: string;

    beforeAll(async () => {
      checkId = await doneExtraction(principal);
    });

    it('los 4 roles ven la lista; recepción sin procedimiento ni intentos (clinicalHidden)', async () => {
      const clinical = await list(tokens.DENTIST!);
      const row = clinical.items.find((i) => i.id === checkId);
      expect(row).toMatchObject({
        patientId: patient,
        patientName: 'Luisa Postop',
        patientPhone: '0414-123-4567',
        whatsAppDigits: '584141234567',
        overdueDays: 0,
        clinicalHidden: false,
        procedureName: 'Extracción simple',
        attempts: [],
        instructions: [],
        attemptsCount: 0,
        locationId: principal,
      });
      for (const role of [ClinicRole.ADMIN, ClinicRole.ASSISTANT]) {
        expect(
          (await list(tokens[role]!)).items.find((i) => i.id === checkId)
            ?.clinicalHidden,
        ).toBe(false);
      }
      const reception = (await list(tokens.RECEPTION!)).items.find(
        (i) => i.id === checkId,
      );
      expect(reception).toMatchObject({
        clinicalHidden: true,
        procedureName: null,
        attempts: null,
        instructions: null,
        patientPhone: '0414-123-4567',
        whatsAppDigits: '584141234567',
      });
    });

    it('recepción no registra el desenlace: 403 en español y nada cambia', async () => {
      const res = await api(a, tokens.RECEPTION!)
        .post(`${ROUTE}/${checkId}/attempts`, { outcome: 'FINE' })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        POST_OP_MESSAGES.forbidden,
      );
      expect(await raw.postOpCheckAttempt.count({ where: { checkId } })).toBe(
        0,
      );
    });

    it('restricción por sede (DX-089): un miembro solo de la Norte no lo ve y pedir la principal es 403', async () => {
      const own = (await api(a, receptionOnlyNorte).get(ROUTE).expect(200))
        .body as PostOpCheckList;
      expect(own.items.map((i) => i.id)).not.toContain(checkId);
      await api(a, receptionOnlyNorte)
        .get(ROUTE, { locationId: principal })
        .expect(403);
      await api(a, receptionOnlyNorte)
        .get(`${ROUTE}/count`, { locationId: principal })
        .expect(403);
      const norteOnly = await list(tokens.ADMIN!, { locationId: norte });
      expect(norteOnly.items.map((i) => i.id)).not.toContain(checkId);
    });

    // ISOLATION_COVERS: POST /post-op-checks/:id/attempts
    it('otra clínica: la sede de A en ?locationId es 403 sin datos de A; su lista no trae nada de A', async () => {
      const res = await api(b, b.adminToken)
        .get(ROUTE, { locationId: principal })
        .expect(403);
      expect(JSON.stringify(res.body)).not.toContain('Luisa');
      await api(b, b.adminToken)
        .get(`${ROUTE}/count`, { locationId: principal })
        .expect(403);
      const own = (await api(b, b.adminToken).get(ROUTE).expect(200))
        .body as PostOpCheckList;
      expect(own.items).toEqual([]);
      await api(b, b.adminToken)
        .post(`${ROUTE}/${checkId}/attempts`, { outcome: 'FINE' })
        .expect(404);
      expect(await raw.postOpCheckAttempt.count({ where: { checkId } })).toBe(
        0,
      );
    });

    it('la lista queda auditada (VIEW POST_OP_CHECK_LIST); el contador no', async () => {
      const before = await raw.auditEvent.count({
        where: { tenantId: a.tenantId, resourceType: 'POST_OP_CHECK' },
      });
      await list(tokens.DENTIST!);
      await count(tokens.DENTIST!);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'POST_OP_CHECK',
          action: 'VIEW',
        },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'POST_OP_CHECK_LIST',
      });
      expect(
        await raw.auditEvent.count({
          where: { tenantId: a.tenantId, resourceType: 'POST_OP_CHECK' },
        }),
      ).toBe(before + 1);
    });
  });

  describe('desenlace (D6) y «Mi día»', () => {
    let checkId: string;

    beforeAll(async () => {
      checkId = await doneExtraction(principal);
    });

    it('el contador de «Mi día» es el de la lista y baja al cerrar; 409 en un control cerrado; auditado sin la nota', async () => {
      const before = (await count(tokens.DENTIST!)).total;
      expect(before).toBeGreaterThan(0);

      await api(a, tokens.ASSISTANT!)
        .post(`${ROUTE}/${checkId}/attempts`, { outcome: 'NO_ANSWER' })
        .expect(200);
      expect((await count(tokens.DENTIST!)).total).toBe(before);

      const res = await api(a, tokens.DENTIST!)
        .post(`${ROUTE}/${checkId}/attempts`, {
          outcome: 'NEEDS_APPOINTMENT',
          note: 'Inflamación; pide revisión esta semana',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        id: checkId,
        status: 'DONE',
        outcome: 'NEEDS_APPOINTMENT',
        attemptsCount: 2,
        addendumId: null,
      });
      expect((res.body as { clinicalEntryId: string }).clinicalEntryId).toEqual(
        expect.any(String),
      );
      expect((await count(tokens.DENTIST!)).total).toBe(before - 1);

      // «Mi día» de quien aún no lo había pedido (sin caché): el mismo número.
      const summary = (
        await api(a, tokens.RECEPTION!).get('/work-queues/summary').expect(200)
      ).body as WorkQueuesSummary;
      expect(summary.items.find((i) => i.key === 'POST_OP_CHECKS')?.count).toBe(
        before - 1,
      );

      const again = await api(a, tokens.DENTIST!)
        .post(`${ROUTE}/${checkId}/attempts`, { outcome: 'FINE' })
        .expect(409);
      expect((again.body as { message: string }).message).toBe(
        POST_OP_MESSAGES.closed,
      );

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'POST_OP_CHECK',
          resourceId: checkId,
          action: 'UPDATE',
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => e.metadata)).toEqual([
        expect.objectContaining({ reason: 'POST_OP_CHECK_NO_ANSWER' }),
        expect.objectContaining({
          reason: 'POST_OP_CHECK_NEEDS_APPOINTMENT',
          statusChange: { from: 'PENDING', to: 'DONE' },
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain('Inflamación');
    });

    it('validación: resultado fuera de la lista o nota larga, 400; id inexistente, 404', async () => {
      await api(a, tokens.DENTIST!)
        .post(`${ROUTE}/${checkId}/attempts`, { outcome: 'MAYBE' })
        .expect(400);
      await api(a, tokens.DENTIST!)
        .post(`${ROUTE}/${checkId}/attempts`, {
          outcome: 'FINE',
          note: 'x'.repeat(1001),
        })
        .expect(400);
      const missing = await api(a, tokens.DENTIST!)
        .post(`${ROUTE}/00000000-0000-4000-8000-000000000566/attempts`, {
          outcome: 'FINE',
        })
        .expect(404);
      expect((missing.body as { message: string }).message).toBe(
        POST_OP_MESSAGES.notFound,
      );
    });
  });
});
