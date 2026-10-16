import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  DocType,
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
  seedMember,
} from './support/e2e-fixtures';

// DX-040 en HTTP real: alternativas A/B, presentar, rechazar, la máquina de
// estados (409), los permisos por rol y la lista de presupuestos por seguir
// (antigüedad, sede, clínica, tope de página). `raw` (DIRECT_URL, owner) solo
// fecha presentaciones en el pasado y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY = 24 * 60 * 60 * 1000;

interface Plan {
  id: string;
  status: string;
  optionGroupId: string | null;
  optionLabel: string | null;
  presentedAt: string | null;
  presentedLocationId: string | null;
  rejectionReason: string | null;
  rejectionNote: string | null;
}

interface FollowUpPage {
  items: {
    planId: string;
    patientName: string;
    patientPhone: string | null;
    patientWhatsApp: string | null;
    optionLabel: string | null;
    daysSincePresented: number;
    total: number;
    currency: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
}

type Role = 'ADMIN' | 'DENTIST' | 'ASSISTANT' | 'RECEPTION';

describe('Alternativas de plan y presupuestos por seguir (e2e, DX-040)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  const tokens = {} as Record<Role, string>;
  let patientA: string;
  let catalogA: string;
  let mainLocationA: string;
  let northLocationA: string;

  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const call =
      (verb: 'get' | 'post' | 'patch' | 'put') =>
      (path: string, body?: object) => {
        const req = request(app.getHttpServer())
          [verb](`/api/v1${path}`)
          .set('X-Tenant-Host', clinic.host)
          .set('Authorization', `Bearer ${token}`);
        return body === undefined ? req : req.send(body);
      };
    return {
      get: call('get'),
      post: call('post'),
      patch: call('patch'),
      put: call('put'),
    };
  };

  async function planWithItem(
    clinic: Clinic,
    patientId: string,
    catalogItemId: string,
    price = 1000000,
  ): Promise<string> {
    const plan = await as(clinic)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'COP' })
      .expect(201);
    const id = (plan.body as Plan).id;
    await as(clinic)
      .post(`/treatment-plans/${id}/items`, {
        toothNumber: '46',
        catalogItemId,
        price,
        discount: 50000,
      })
      .expect(201);
    return id;
  }

  async function catalogItem(clinic: Clinic, code: string): Promise<string> {
    const res = await as(clinic)
      .post('/catalog/items', {
        code,
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Implante',
        color: '#2A2B3C',
        defaultPrice: 1000000,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  let patientSeq = 0;
  async function patient(clinic: Clinic, firstName: string, phone?: string) {
    const res = await as(clinic)
      .post('/patients', {
        firstName,
        lastName: 'Seguimiento',
        docType: DocType.CC,
        docNumber: `40${++patientSeq}`,
        sex: Sex.F,
        phone,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Presenta el plan y lo fecha `days` días atrás (solo la fecha, por owner). */
  async function presentDaysAgo(id: string, days: number, location?: string) {
    const req = as(clinicA).post(`/treatment-plans/${id}/present`);
    if (location) req.set('X-Location-Id', location);
    await req.expect(200);
    await raw.treatmentPlan.update({
      where: { id },
      data: { presentedAt: new Date(Date.now() - days * DAY) },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'alternativas-a');
    clinicB = await registerClinic(app, 'alternativas-b');
    tokens.ADMIN = clinicA.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinicA, role);
      tokens[role] = await loginAs(app, clinicA.host, member.email);
    }
    // Sin horario de atención: la cita de prueba se agenda a cualquier hora
    // (mismo criterio que tenant-isolation-matrix.e2e-spec.ts).
    await as(clinicA)
      .put('/locations/schedule', { timezone: 'America/Bogota', ranges: [] })
      .expect(200);
    catalogA = await catalogItem(clinicA, 'IMPL-A');
    patientA = await patient(clinicA, 'Ana', '+57 300 111 2222');
    const locations = await as(clinicA).get('/locations').expect(200);
    mainLocationA = (locations.body as { id: string }[])[0].id;
    const north = await as(clinicA)
      .post('/locations', { name: 'Sede Norte' })
      .expect(201);
    northLocationA = (north.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('alternativas y aceptación', () => {
    let optionA: string;
    let optionB: string;

    beforeAll(async () => {
      optionA = await planWithItem(clinicA, patientA, catalogA);
    });

    it('crear una alternativa abre el grupo: A y B, mismo paciente, ítems copiados', async () => {
      const res = await as(clinicA, tokens.ASSISTANT)
        .post(`/treatment-plans/${optionA}/alternatives`, {
          optionLabel: 'Opción B: puente',
        })
        .expect(201);
      const created = res.body as Plan;
      optionB = created.id;
      expect(created).toMatchObject({
        status: 'DRAFT',
        optionGroupId: optionA,
        optionLabel: 'Opción B: puente',
      });
      const detail = await as(clinicA).get(`/treatment-plans/${optionB}`);
      expect(detail.body).toMatchObject({ total: 950000 });
      const source = await as(clinicA).get(`/treatment-plans/${optionA}`);
      expect(source.body).toMatchObject({
        optionGroupId: optionA,
        optionLabel: 'Opción A',
      });
    });

    it('la asistente no presenta, no rechaza y no acepta (403); recepción no presenta', async () => {
      await as(clinicA, tokens.ASSISTANT)
        .post(`/treatment-plans/${optionA}/present`)
        .expect(403);
      await as(clinicA, tokens.RECEPTION)
        .post(`/treatment-plans/${optionA}/present`)
        .expect(403);
      await as(clinicA, tokens.ASSISTANT)
        .post(`/treatment-plans/${optionA}/reject`, { reason: 'PRICE' })
        .expect(403);
      const accept = await as(clinicA, tokens.ASSISTANT)
        .patch(`/treatment-plans/${optionA}`, { status: 'ACCEPTED' })
        .expect(403);
      expect((accept.body as { message: string }).message).toBe(
        'Solo el odontólogo o la administración aceptan un plan de tratamiento.',
      );
    });

    it('el odontólogo presenta las dos opciones; con la sede del request', async () => {
      for (const id of [optionA, optionB]) {
        const res = await as(clinicA, tokens.DENTIST)
          .post(`/treatment-plans/${id}/present`)
          .set('X-Location-Id', northLocationA)
          .expect(200);
        expect(res.body).toMatchObject({
          status: 'PRESENTED',
          presentedLocationId: northLocationA,
        });
      }
    });

    it('presentar, crear alternativa y consultar la lista quedan auditados (DX-009)', async () => {
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinicA.tenantId, resourceType: 'TREATMENT_PLAN' },
        select: { action: true, resourceId: true, patientId: true },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          { action: 'UPDATE', resourceId: optionA, patientId: patientA },
          { action: 'CREATE', resourceId: optionB, patientId: patientA },
        ]),
      );
    });

    it('presentar dos veces es una transición inválida (409)', async () => {
      const res = await as(clinicA)
        .post(`/treatment-plans/${optionA}/present`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Un plan «Presentado» no puede pasar a «Presentado».',
      );
    });

    it('el PATCH no presenta ni rechaza (400)', async () => {
      await as(clinicA)
        .patch(`/treatment-plans/${optionA}`, { status: 'REJECTED' })
        .expect(400);
    });

    it('aceptar la opción A deja la B rechazada por «otra opción aceptada»', async () => {
      await as(clinicA, tokens.DENTIST)
        .patch(`/treatment-plans/${optionA}`, { status: 'ACCEPTED' })
        .expect(200);
      const b = await as(clinicA).get(`/treatment-plans/${optionB}`);
      expect(b.body).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'OTHER_OPTION_ACCEPTED',
      });
    });

    it('REJECTED → ACCEPTED y COMPLETED → PRESENTED son 409', async () => {
      await as(clinicA)
        .patch(`/treatment-plans/${optionB}`, { status: 'ACCEPTED' })
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${optionA}`, { status: 'COMPLETED' })
        .expect(200);
      await as(clinicA).post(`/treatment-plans/${optionA}/present`).expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${optionA}`, { status: 'CANCELLED' })
        .expect(409);
    });

    it('un grupo con una opción elegida no admite más alternativas (409)', async () => {
      await as(clinicA)
        .post(`/treatment-plans/${optionB}/alternatives`, {})
        .expect(409);
    });
  });

  describe('rechazar', () => {
    let presented: string;

    beforeAll(async () => {
      presented = await planWithItem(clinicA, patientA, catalogA);
      await as(clinicA)
        .post(`/treatment-plans/${presented}/present`)
        .expect(200);
    });

    it('sin motivo → 400 en español', async () => {
      const res = await as(clinicA, tokens.RECEPTION)
        .post(`/treatment-plans/${presented}/reject`, {})
        .expect(400);
      expect((res.body as { message: string[] }).message).toContain(
        'Elige el motivo del rechazo: precio, miedo, segunda opinión u otro.',
      );
    });

    it('motivo fuera del catálogo → 400; OTHER sin nota → 400; OTHER_OPTION_ACCEPTED → 400', async () => {
      await as(clinicA)
        .post(`/treatment-plans/${presented}/reject`, { reason: 'CARO' })
        .expect(400);
      const other = await as(clinicA)
        .post(`/treatment-plans/${presented}/reject`, { reason: 'OTHER' })
        .expect(400);
      expect((other.body as { message: string }).message).toBe(
        'Con el motivo «Otro» describe en la nota por qué lo rechazó.',
      );
      await as(clinicA)
        .post(`/treatment-plans/${presented}/reject`, {
          reason: 'OTHER_OPTION_ACCEPTED',
        })
        .expect(400);
    });

    it('recepción lo marca rechazado con motivo y nota', async () => {
      const res = await as(clinicA, tokens.RECEPTION)
        .post(`/treatment-plans/${presented}/reject`, {
          reason: 'OTHER',
          note: 'Se va a vivir a otra ciudad',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'OTHER',
        rejectionNote: 'Se va a vivir a otra ciudad',
      });
    });

    it('un plan presentado con abonos no se rechaza (409 en español)', async () => {
      const paid = await planWithItem(clinicA, patientA, catalogA);
      await as(clinicA).post(`/treatment-plans/${paid}/present`).expect(200);
      await as(clinicA)
        .post(`/treatment-plans/${paid}/payments`, {
          amount: 10000,
          currency: 'COP',
          paidAt: new Date().toISOString(),
          method: 'CASH',
        })
        .expect(201);
      const res = await as(clinicA, tokens.RECEPTION)
        .post(`/treatment-plans/${paid}/reject`, { reason: 'PRICE' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'El plan tiene abonos registrados: no se puede marcar como rechazado. Anula los abonos o cancela el plan.',
      );
    });

    it('estado fuera del enum → 400 en español; id que no es UUID → 400', async () => {
      const res = await as(clinicA)
        .patch(`/treatment-plans/${presented}`, { status: 'CERRADO' })
        .expect(400);
      expect((res.body as { message: string[] }).message).toContain(
        'Estado de plan no válido.',
      );
      await as(clinicA).get('/treatment-plans/no-es-uuid').expect(400);
      await as(clinicA)
        .get('/treatment-plans/pending-follow-up?page=100001')
        .expect(400);
    });

    it('un borrador no se rechaza (409)', async () => {
      const draft = await planWithItem(clinicA, patientA, catalogA);
      await as(clinicA)
        .post(`/treatment-plans/${draft}/reject`, { reason: 'PRICE' })
        .expect(409);
    });

    it('un plan sin ítems no se presenta (400)', async () => {
      const empty = await as(clinicA)
        .post(`/patients/${patientA}/treatment-plans`, { currency: 'COP' })
        .expect(201);
      await as(clinicA)
        .post(`/treatment-plans/${(empty.body as Plan).id}/present`)
        .expect(400);
    });
  });

  describe('presupuestos por seguir', () => {
    let due: string;
    let dueNorth: string;
    let booked: string;
    let recent: string;
    let foreign: string;

    beforeAll(async () => {
      await raw.treatmentPlan.updateMany({
        where: { tenantId: clinicA.tenantId, status: 'PRESENTED' },
        data: { status: 'CANCELLED' },
      });
      const duePatient = await patient(clinicA, 'Laura', '+57 300 555 6666');
      due = await planWithItem(clinicA, duePatient, catalogA, 2000000);
      await presentDaysAgo(due, 10, mainLocationA);

      const northPatient = await patient(clinicA, 'Norte');
      dueNorth = await planWithItem(clinicA, northPatient, catalogA);
      await presentDaysAgo(dueNorth, 20, northLocationA);

      const bookedPatient = await patient(clinicA, 'Con cita');
      booked = await planWithItem(clinicA, bookedPatient, catalogA);
      await presentDaysAgo(booked, 10, mainLocationA);
      const start = new Date(Date.now() + 5 * DAY);
      start.setUTCHours(15, 0, 0, 0);
      await as(clinicA)
        .post('/appointments', {
          patientId: bookedPatient,
          providerId: clinicA.adminUserId,
          start: start.toISOString(),
          end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
        })
        .expect(201);

      const recentPatient = await patient(clinicA, 'Reciente');
      recent = await planWithItem(clinicA, recentPatient, catalogA);
      await presentDaysAgo(recent, 2, mainLocationA);

      const catalogB = await catalogItem(clinicB, 'IMPL-B');
      const patientB = await patient(clinicB, 'Ajena');
      foreign = await planWithItem(clinicB, patientB, catalogB);
      await as(clinicB).post(`/treatment-plans/${foreign}/present`).expect(200);
      await raw.treatmentPlan.update({
        where: { id: foreign },
        data: { presentedAt: new Date(Date.now() - 30 * DAY) },
      });
    });

    it('ADMIN y recepción la ven; odontólogo y asistente no (403)', async () => {
      await as(clinicA, tokens.RECEPTION)
        .get('/treatment-plans/pending-follow-up')
        .expect(200);
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: clinicA.tenantId,
            action: 'VIEW',
            resourceType: 'TREATMENT_PLAN',
            resourceId: null,
            patientId: null,
          },
        }),
      ).toBeGreaterThanOrEqual(1);
      await as(clinicA, tokens.DENTIST)
        .get('/treatment-plans/pending-follow-up')
        .expect(403);
      await as(clinicA, tokens.ASSISTANT)
        .get('/treatment-plans/pending-follow-up')
        .expect(403);
    });

    it('solo PRESENTED con más de 7 días y sin cita futura, con monto, moneda y teléfono', async () => {
      const res = await as(clinicA, tokens.RECEPTION)
        .get('/treatment-plans/pending-follow-up')
        .expect(200);
      const page = res.body as FollowUpPage;
      expect(page.items.map((i) => i.planId)).toEqual([dueNorth, due]);
      expect(page.items[1]).toMatchObject({
        patientName: 'Laura Seguimiento',
        patientPhone: '+57 300 555 6666',
        patientWhatsApp: '573005556666',
        total: 1950000,
        currency: 'COP',
        daysSincePresented: 10,
      });
      const ids = page.items.map((i) => i.planId);
      expect(ids).not.toContain(booked);
      expect(ids).not.toContain(recent);
      expect(ids).not.toContain(foreign);
    });

    it('filtra por la sede activa (X-Location-Id)', async () => {
      const res = await as(clinicA, tokens.RECEPTION)
        .get('/treatment-plans/pending-follow-up')
        .set('X-Location-Id', northLocationA)
        .expect(200);
      expect((res.body as FollowUpPage).items.map((i) => i.planId)).toEqual([
        dueNorth,
      ]);
    });

    it('olderThanDays, paginado y tope de pageSize', async () => {
      const recentToo = await as(clinicA)
        .get('/treatment-plans/pending-follow-up?olderThanDays=1')
        .expect(200);
      expect((recentToo.body as FollowUpPage).total).toBe(3);
      const page2 = await as(clinicA)
        .get('/treatment-plans/pending-follow-up?page=2&pageSize=1')
        .expect(200);
      expect(page2.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect((page2.body as FollowUpPage).items.map((i) => i.planId)).toEqual([
        due,
      ]);
      const capped = await as(clinicA)
        .get('/treatment-plans/pending-follow-up?pageSize=5000')
        .expect(200);
      expect((capped.body as FollowUpPage).pageSize).toBe(100);
      await as(clinicA)
        .get('/treatment-plans/pending-follow-up?olderThanDays=-1')
        .expect(400);
    });

    it('la otra clínica solo ve lo suyo; una sede ajena en X-Location-Id → 400', async () => {
      const res = await as(clinicB)
        .get('/treatment-plans/pending-follow-up')
        .expect(200);
      expect((res.body as FollowUpPage).items.map((i) => i.planId)).toEqual([
        foreign,
      ]);
      await as(clinicB)
        .get('/treatment-plans/pending-follow-up')
        .set('X-Location-Id', northLocationA)
        .expect(400);
    });

    it('la otra clínica no presenta, rechaza ni ramifica planes de A (404)', async () => {
      await as(clinicB).post(`/treatment-plans/${due}/present`).expect(404);
      await as(clinicB)
        .post(`/treatment-plans/${due}/reject`, { reason: 'PRICE' })
        .expect(404);
      await as(clinicB)
        .post(`/treatment-plans/${due}/alternatives`, {})
        .expect(404);
      const still = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: due },
      });
      expect(still.status).toBe('PRESENTED');
    });

    it('al rechazarlo desde la lista, sale de ella', async () => {
      await as(clinicA, tokens.RECEPTION)
        .post(`/treatment-plans/${due}/reject`, { reason: 'PRICE' })
        .expect(200);
      const res = await as(clinicA, tokens.RECEPTION)
        .get('/treatment-plans/pending-follow-up')
        .expect(200);
      expect((res.body as FollowUpPage).items.map((i) => i.planId)).toEqual([
        dueNorth,
      ]);
    });
  });
});
