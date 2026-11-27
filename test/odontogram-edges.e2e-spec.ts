import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';
import { addCivilDays, zonedStartOfDay } from '../src/shared/time/civil-day';
import { SEDE_FIXTURE_ZONE, fixedSedeDay } from './support/sede-clock';

// DX-132 · bordes del odontograma de punta a punta:
//   - marcar «Realizado» un ítem del plan aplica la regla posición/dentición
//     del alta manual (422 en español) y, si su copia se anuló, la vuelve a
//     copiar con un registro NUEVO (append-only);
//   - el historial de un diente a una fecha corta en el día de la sede (el
//     mismo corte que la carta), no en UTC ni en la zona del navegador;
//   - basis MANUAL, ERUPTION → PRIMARY 422, anular con {} un solo mensaje y
//     asOf futuro 400 con código;
//   - roles y aislamiento entre clínicas.
// DIRECT_URL (superusuario) solo para sembrar, leer y limpiar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// La sede principal de A es la de sede-clock (Caracas, UTC−4).
const CARACAS = SEDE_FIXTURE_ZONE;
const REASON = 'Registrado en el diente equivocado';
const ALL_POSITIONS = [1, 2, 3, 4].flatMap((q) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${q}${n}`),
);

interface RecordBody {
  id: string;
  toothNumber: string;
  sourcePlanItemId: string | null;
}
interface TimelineBody extends RecordBody {
  void: { reason: string } | null;
}
interface GroupBody {
  toothNumber: string;
  records: RecordBody[];
}
interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
  fields?: { field: string; message: string }[];
}

/**
 * Día civil de Caracas `daysAgo` días atrás (la sede principal de A), por
 * sede-clock (DX-449): ningún caso depende de la medianoche (5 días atrás, 2
 * adelante, 31 para la edad).
 */
function caracasDay(daysAgo: number): string {
  return fixedSedeDay(daysAgo).day;
}

/** Fecha de nacimiento de quien tiene `years` años (y un mes) hoy. */
function birthDateFor(years: number): Date {
  const [y, m, d] = caracasDay(31).split('-').map(Number);
  return new Date(Date.UTC(y - years, m - 1, d));
}

describe('Odontograma: bordes del espejo del plan, historial a una fecha y validaciones (DX-132, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let receptionToken: string;
  let mainLocationId: string;
  let tokyoLocationId: string;
  let catalogItemId: string;

  const http = () => request(app.getHttpServer());

  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'patch',
    path: string,
    token = clinic.adminToken,
    locationId?: string,
  ) {
    let req = http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    if (locationId) req = req.set('X-Location-Id', locationId);
    return req;
  }

  async function patient(name: string, birthDate: Date | null) {
    return (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: name,
          lastName: 'González',
          birthDate,
        },
      })
    ).id;
  }

  async function planFor(patientId: string): Promise<string> {
    const res = await call(a, 'post', `/patients/${patientId}/treatment-plans`)
      .send({ currency: 'USD' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function acceptedItem(planId: string, tooth: string): Promise<string> {
    const res = await call(a, 'post', `/treatment-plans/${planId}/items`)
      .send({ toothNumber: tooth, catalogItemId, price: 40 })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await call(a, 'patch', `/treatment-plans/${planId}/items/${id}`)
      .send({ status: 'ACCEPTED' })
      .expect(200);
    return id;
  }

  function markDone(planId: string, itemId: string) {
    return call(
      a,
      'patch',
      `/treatment-plans/${planId}/items/${itemId}`,
      dentist.token,
      mainLocationId,
    ).send({ status: 'DONE' });
  }

  function unmark(planId: string, itemId: string) {
    return call(
      a,
      'patch',
      `/treatment-plans/${planId}/items/${itemId}`,
      dentist.token,
      mainLocationId,
    )
      .send({ status: 'ACCEPTED' })
      .expect(200);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx132-a', REGIONAL_CARACAS_FIXTURE);
    b = await registerClinic(app, 'dx132-b', REGIONAL_CARACAS_FIXTURE);
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { userId: d.userId, token: await loginAs(app, a.host, d.email) };
    const r = await seedMember(raw, a, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, a.host, r.email);

    const locations = await call(a, 'get', '/locations').expect(200);
    mainLocationId = (locations.body as { id: string }[])[0].id;
    const tokyo = await call(a, 'post', '/locations')
      .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Sede Oriente' }))
      .expect(201);
    tokyoLocationId = (tokyo.body as { id: string }).id;

    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const catalog = await call(a, 'post', '/catalog/items')
      .send({
        code: 'PULPO-132',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Pulpotomía',
        color: '#2A2B3C',
        defaultPrice: 40,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('espejo plan → odontograma', () => {
    let adult: string;
    let adultPlan: string;
    let child: string;
    let childPlan: string;

    beforeAll(async () => {
      adult = await patient('José', birthDateFor(34));
      adultPlan = await planFor(adult);
      child = await patient('Valentina', birthDateFor(4));
      childPlan = await planFor(child);
    });

    it('«Realizado» en un temporal (55) de una posición permanente: 422 en español y el ítem no cambia', async () => {
      const itemId = await acceptedItem(adultPlan, '55');

      const res = await markDone(adultPlan, itemId).expect(422);

      expect(res.body as ErrorBody).toEqual({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'TOOTH_DENTITION_MISMATCH',
        message:
          'El diente 55 es temporal, pero la posición 15 está en dentición permanente. Cambia la dentición de esa posición (mixta o temporal) antes de marcarlo como realizado.',
      });
      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.status).toBe('ACCEPTED');
      expect(item.performedById).toBeNull();
      expect(
        await raw.toothRecord.count({ where: { sourcePlanItemId: itemId } }),
      ).toBe(0);
    });

    it('el alta manual responde el mismo 422 (con «antes de registrar»)', async () => {
      const res = await call(a, 'post', `/patients/${adult}/tooth-records`)
        .send({ toothNumber: '55', kind: 'PROCEDURE' })
        .expect(422);
      expect(res.body as ErrorBody).toMatchObject({
        code: 'TOOTH_DENTITION_MISMATCH',
        message: expect.stringMatching(/antes de registrar\.$/) as unknown,
      });
    });

    it('anulada la copia, volver a marcarlo «Realizado» lo pinta otra vez con un registro nuevo', async () => {
      const itemId = await acceptedItem(childPlan, '55');
      await markDone(childPlan, itemId).expect(200);
      const first = await raw.toothRecord.findFirstOrThrow({
        where: { sourcePlanItemId: itemId },
      });

      await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${first.id}/void`,
        dentist.token,
      )
        .send({ reason: REASON })
        .expect(200);
      let chart = await call(a, 'get', `/patients/${child}/odontogram`).expect(
        200,
      );
      expect((chart.body as GroupBody[]).map((g) => g.toothNumber)).toEqual([]);
      const rowsBefore = await raw.toothRecord.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      });

      await unmark(childPlan, itemId);
      await markDone(childPlan, itemId).expect(200);

      chart = await call(a, 'get', `/patients/${child}/odontogram`).expect(200);
      const groups = chart.body as GroupBody[];
      expect(groups.map((g) => g.toothNumber)).toEqual(['55']);
      const recopy = groups[0].records[0];
      expect(recopy.id).not.toBe(first.id);
      expect(recopy.sourcePlanItemId).toBe(itemId);
      const recopyRow = await raw.toothRecord.findUniqueOrThrow({
        where: { id: recopy.id },
      });
      expect(recopyRow.replacesRecordId).toBe(first.id);

      // Append-only: ninguna fila previa cambió.
      expect(
        await raw.toothRecord.findMany({
          where: { id: { in: rowsBefore.map((r) => r.id) } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(rowsBefore);

      // El historial muestra la copia nueva y la anulada, tachada.
      const history = await call(
        a,
        'get',
        `/patients/${child}/teeth/55/history`,
      ).expect(200);
      const entries = history.body as TimelineBody[];
      expect(entries.map((e) => [e.id, e.void?.reason ?? null])).toEqual([
        [recopy.id, null],
        [first.id, REASON],
      ]);

      // Y su audit_event, firmado por quien marcó.
      const audit = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'ODONTOGRAM',
          resourceId: recopy.id,
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'CREATE',
        actorUserId: dentist.userId,
        patientId: child,
        locationId: mainLocationId,
      });
      expect(audit[0].metadata).toMatchObject({
        reason: 'PLAN_ITEM_MIRROR_RECOPIED',
      });
    });

    it('sin anular, salir de «Realizado» y volver no duplica la copia', async () => {
      const itemId = await acceptedItem(childPlan, '54');
      await markDone(childPlan, itemId).expect(200);
      await unmark(childPlan, itemId);
      await markDone(childPlan, itemId).expect(200);
      expect(
        await raw.toothRecord.count({ where: { sourcePlanItemId: itemId } }),
      ).toBe(1);
    });
  });

  describe('dentición', () => {
    it('basis MANUAL tras cambiar a mano toda la carta (antes «Según la edad»)', async () => {
      const kid = await patient('Daniela', birthDateFor(4));
      const before = await call(a, 'get', `/patients/${kid}/dentition`).expect(
        200,
      );
      expect((before.body as { basis: string }).basis).toBe('AGE');

      await call(a, 'post', `/patients/${kid}/dentition-events`, dentist.token)
        .send({
          positions: ALL_POSITIONS,
          dentition: 'PERMANENT',
          reason: 'MANUAL',
        })
        .expect(201);

      const after = await call(a, 'get', `/patients/${kid}/dentition`).expect(
        200,
      );
      expect(after.body).toMatchObject({
        basis: 'MANUAL',
        ageYears: 4,
        overall: 'PERMANENT',
      });
    });

    it('ERUPTION hacia PRIMARY: 422 en español, sin escribir', async () => {
      const kid = await patient('Sofía', birthDateFor(7));
      const res = await call(
        a,
        'post',
        `/patients/${kid}/dentition-events`,
        dentist.token,
      )
        .send({ positions: ['11'], dentition: 'PRIMARY', reason: 'ERUPTION' })
        .expect(422);
      expect((res.body as ErrorBody).message).toBe(
        'Una erupción deja la posición en dentición mixta o permanente, no temporal',
      );
      expect(
        await raw.patientDentitionEvent.count({ where: { patientId: kid } }),
      ).toBe(0);
    });
  });

  describe('anular con cuerpo {}', () => {
    it('un solo mensaje de validación del motivo', async () => {
      const adult = await patient('Luis', null);
      const record = await raw.toothRecord.create({
        data: {
          tenantId: a.tenantId,
          patientId: adult,
          toothNumber: '36',
          kind: 'DIAGNOSIS',
          performedById: a.adminUserId,
        },
      });
      const res = await call(
        a,
        'post',
        `/patients/${adult}/tooth-records/${record.id}/void`,
      )
        .send({})
        .expect(400);
      const body = res.body as ErrorBody;
      expect(body.message).toEqual([
        'El motivo de la anulación es obligatorio',
      ]);
      expect(body.fields).toHaveLength(1);
      expect(body.fields?.[0]).toMatchObject({ field: 'reason' });
    });
  });

  describe('historial de un diente a una fecha (día de la sede)', () => {
    let adult: string;
    let lateNight: string;
    let earlyMorning: string;
    const day = caracasDay(5);

    beforeAll(async () => {
      adult = await patient('Carmen', birthDateFor(40));
      // 23:30 en Caracas del día `day` (03:30 UTC del día siguiente) y 00:30
      // del día siguiente en Caracas. Por SQL: la API no antedata.
      const nextStart = zonedStartOfDay(addCivilDays(day, 1), CARACAS);
      const at = (minutes: number) =>
        new Date(nextStart.getTime() + minutes * 60_000);
      lateNight = (
        await raw.toothRecord.create({
          data: {
            tenantId: a.tenantId,
            patientId: adult,
            toothNumber: '26',
            kind: 'DIAGNOSIS',
            recordedAt: at(-30),
          },
        })
      ).id;
      earlyMorning = (
        await raw.toothRecord.create({
          data: {
            tenantId: a.tenantId,
            patientId: adult,
            toothNumber: '26',
            kind: 'PROCEDURE',
            recordedAt: at(30),
          },
        })
      ).id;
      // Lo anulado después de `day` sigue sin anular en el historial de ese día.
      await call(
        a,
        'post',
        `/patients/${adult}/tooth-records/${lateNight}/void`,
      )
        .send({ reason: REASON })
        .expect(200);
    });

    async function historyAndChart(asOf: string, locationId?: string) {
      const history = await call(
        a,
        'get',
        `/patients/${adult}/teeth/26/history?asOf=${asOf}`,
        a.adminToken,
        locationId,
      ).expect(200);
      const chart = await call(
        a,
        'get',
        `/patients/${adult}/odontogram?asOf=${asOf}`,
        a.adminToken,
        locationId,
      ).expect(200);
      return {
        history: history.body as TimelineBody[],
        chart: (chart.body as GroupBody[]).find((g) => g.toothNumber === '26'),
      };
    }

    it('sin X-Location-Id manda la sede principal (Caracas): entra lo de las 23:30 y no lo de las 00:30', async () => {
      const { history, chart } = await historyAndChart(day);
      expect(history.map((e) => e.id)).toEqual([lateNight]);
      expect(history[0].void).toBeNull();
      // Coincide con la carta de esa fecha.
      expect(chart?.records.map((r) => r.id)).toEqual([lateNight]);
    });

    it('al día siguiente entran los dos, y lo anulado hoy aún no sale anulado', async () => {
      const { history, chart } = await historyAndChart(addCivilDays(day, 1));
      expect(history.map((e) => e.id)).toEqual([earlyMorning, lateNight]);
      expect(history.every((e) => e.void === null)).toBe(true);
      expect(chart?.records.map((r) => r.id)).toEqual([
        lateNight,
        earlyMorning,
      ]);
    });

    it('con X-Location-Id manda esa sede (Tokio): los dos son del día siguiente allí', async () => {
      const { history, chart } = await historyAndChart(day, tokyoLocationId);
      expect(history).toEqual([]);
      expect(chart).toBeUndefined();
    });

    it('sin asOf: todo, con la anulación', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${adult}/teeth/26/history`,
      ).expect(200);
      const entries = res.body as TimelineBody[];
      expect(entries.find((e) => e.id === lateNight)?.void?.reason).toBe(
        REASON,
      );
    });

    it.each([
      [
        'historial',
        (p: string, q: string) => `/patients/${p}/teeth/26/history?asOf=${q}`,
      ],
      [
        'carta',
        (p: string, q: string) => `/patients/${p}/odontogram?asOf=${q}`,
      ],
      [
        'dentición',
        (p: string, q: string) => `/patients/${p}/dentition?asOf=${q}`,
      ],
    ])(
      'asOf futuro en %s: 400 «La fecha de la carta no puede ser futura»',
      async (_l, path) => {
        const res = await call(a, 'get', path(adult, caracasDay(-2))).expect(
          400,
        );
        expect(res.body as ErrorBody).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          code: 'ODONTOGRAM_AS_OF_FUTURE',
          message: 'La fecha de la carta no puede ser futura',
        });
      },
    );

    it('asOf que no existe: 400 ODONTOGRAM_AS_OF_INVALID', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${adult}/teeth/26/history?asOf=2026-02-30`,
      ).expect(400);
      expect((res.body as ErrorBody).code).toBe('ODONTOGRAM_AS_OF_INVALID');
    });

    it('roles: RECEPTION no ve el historial clínico (403)', async () => {
      await call(
        a,
        'get',
        `/patients/${adult}/teeth/26/history?asOf=${day}`,
        receptionToken,
      ).expect(403);
    });

    it('aislamiento: la clínica B no ve nada del historial de A a esa fecha', async () => {
      const res = await call(
        b,
        'get',
        `/patients/${adult}/teeth/26/history?asOf=${day}`,
      ).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('aislamiento del espejo', () => {
    it('la clínica B no marca «Realizado» un ítem de A: 404 y sin copia', async () => {
      const kid = await patient('Andrea', birthDateFor(4));
      const planId = await planFor(kid);
      const itemId = await acceptedItem(planId, '55');
      await call(b, 'patch', `/treatment-plans/${planId}/items/${itemId}`)
        .send({ status: 'DONE' })
        .expect(404);
      expect(
        await raw.toothRecord.count({ where: { sourcePlanItemId: itemId } }),
      ).toBe(0);
    });
  });
});
