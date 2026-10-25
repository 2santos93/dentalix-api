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
import {
  ADMIN_HAS_ALL_LOCATIONS_MESSAGE,
  STAFF_MEMBER_NOT_FOUND_MESSAGE,
  UNKNOWN_LOCATION_MESSAGE,
} from '../src/modules/staff/application/use-cases/staff-locations.use-cases';

// DX-089: sedes permitidas por miembro. GET/PUT /staff/:userId/locations
// (solo ADMIN), el ADMIN siempre con todas, ascender a ADMIN las limpia y
// GET /staff expone `locationIds` (null = todas) para la agenda.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface StaffLocationsBody {
  all: boolean;
  locationIds: string[];
}

interface StaffListItem {
  userId: string;
  role: ClinicRole;
  locationIds: string[] | null;
}

describe('Sedes permitidas por miembro (DX-089)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let recepcion: { userId: string; email: string };
  let dentista: { userId: string; email: string };
  let recepcionToken: string;
  let dentistaToken: string;
  let a1: string;
  let a2: string;
  let aInactiva: string;
  let b1: string;

  function api(clinic: Clinic, token: string) {
    const server = app.getHttpServer();
    const auth = (t: request.Test) =>
      t
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      post: (path: string, body: object) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(request(server).delete(`/api/v1${path}`)),
    };
  }

  async function firstLocationOf(clinic: Clinic): Promise<string> {
    const res = await api(clinic, clinic.adminToken)
      .get('/locations')
      .expect(200);
    return (res.body as { id: string }[])[0].id;
  }

  async function createLocation(name: string): Promise<string> {
    const res = await api(a, a.adminToken)
      .post('/locations', { name })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function rowsOf(userId: string): Promise<number> {
    return raw.membershipLocation.count({
      where: { tenantId: a.tenantId, membership: { userId } },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx089-sedes-a');
    b = await registerClinic(app, 'dx089-sedes-b');
    recepcion = await seedMember(raw, a, ClinicRole.RECEPTION);
    dentista = await seedMember(raw, a, ClinicRole.DENTIST);
    recepcionToken = await loginAs(app, a.host, recepcion.email);
    dentistaToken = await loginAs(app, a.host, dentista.email);
    a1 = await firstLocationOf(a);
    a2 = await createLocation('Sede Norte');
    aInactiva = await createLocation('Sede Cerrada');
    await api(a, a.adminToken)
      .patch(`/locations/${aInactiva}`, { isActive: false })
      .expect(200);
    b1 = await firstLocationOf(b);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('sin restricción el miembro tiene todas las sedes', async () => {
    const res = await api(a, a.adminToken)
      .get(`/staff/${recepcion.userId}/locations`)
      .expect(200);
    expect(res.body).toEqual({ all: true, locationIds: [] });
  });

  it('el ADMIN restringe a recepción a una sede y el GET lo refleja', async () => {
    const put = await api(a, a.adminToken)
      .put(`/staff/${recepcion.userId}/locations`, { locationIds: [a1, a1] })
      .expect(200);
    expect(put.body).toEqual({ all: false, locationIds: [a1] });

    const get = await api(a, a.adminToken)
      .get(`/staff/${recepcion.userId}/locations`)
      .expect(200);
    expect(get.body as StaffLocationsBody).toEqual({
      all: false,
      locationIds: [a1],
    });
    expect(await rowsOf(recepcion.userId)).toBe(1);

    const row = await raw.membershipLocation.findFirstOrThrow({
      where: { tenantId: a.tenantId, membership: { userId: recepcion.userId } },
    });
    expect(row.createdById).toBe(a.adminUserId);
  });

  it('queda auditado como UPDATE de STAFF_MEMBER con reason LOCATIONS_CHANGED', async () => {
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        action: 'UPDATE',
        resourceType: 'STAFF_MEMBER',
        resourceId: recepcion.userId,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: a.adminUserId,
      actorRole: 'ADMIN',
      metadata: { reason: 'LOCATIONS_CHANGED' },
    });
  });

  it('GET /staff y el perfil muestran las sedes de recepción y null en el resto', async () => {
    const list = await api(a, dentistaToken).get('/staff').expect(200);
    const byId = new Map(
      (list.body as StaffListItem[]).map((m) => [m.userId, m.locationIds]),
    );
    expect(byId.get(recepcion.userId)).toEqual([a1]);
    expect(byId.get(dentista.userId)).toBeNull();
    expect(byId.get(a.adminUserId)).toBeNull();

    const detail = await api(a, a.adminToken)
      .get(`/staff/${recepcion.userId}`)
      .expect(200);
    expect(detail.body).toMatchObject({ locationIds: [a1] });
  });

  it('una sede de otra clínica da 400 y no toca las filas', async () => {
    const res = await api(a, a.adminToken)
      .put(`/staff/${recepcion.userId}/locations`, { locationIds: [a2, b1] })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      UNKNOWN_LOCATION_MESSAGE,
    );
    expect(await rowsOf(recepcion.userId)).toBe(1);
  });

  it('una sede inactiva da 400 y no toca las filas', async () => {
    const res = await api(a, a.adminToken)
      .put(`/staff/${recepcion.userId}/locations`, { locationIds: [aInactiva] })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      UNKNOWN_LOCATION_MESSAGE,
    );
    expect(await rowsOf(recepcion.userId)).toBe(1);
  });

  it('un id que no es UUID da 400 de validación', async () => {
    const res = await api(a, a.adminToken)
      .put(`/staff/${recepcion.userId}/locations`, { locationIds: ['x'] })
      .expect(400);
    expect((res.body as { message: string[] }).message).toContain(
      'Alguna sede no es válida.',
    );
  });

  it('el ADMIN no se puede restringir (409) ni aunque lo pida él mismo', async () => {
    const res = await api(a, a.adminToken)
      .put(`/staff/${a.adminUserId}/locations`, { locationIds: [a1] })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      ADMIN_HAS_ALL_LOCATIONS_MESSAGE,
    );
    expect(await rowsOf(a.adminUserId)).toBe(0);
  });

  it('un ADMIN que arrastra filas de sedes figura igualmente con todas', async () => {
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: a.adminUserId },
      select: { id: true },
    });
    const stale = await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: membership.id,
        locationId: a1,
      },
    });
    try {
      await api(a, a.adminToken)
        .get(`/staff/${a.adminUserId}/locations`)
        .expect(200, { all: true, locationIds: [] });
      const list = await api(a, a.adminToken).get('/staff').expect(200);
      const admin = (list.body as StaffListItem[]).find(
        (m) => m.userId === a.adminUserId,
      );
      expect(admin?.locationIds).toBeNull();
      const detail = await api(a, a.adminToken)
        .get(`/staff/${a.adminUserId}`)
        .expect(200);
      expect(detail.body).toMatchObject({ locationIds: null });
    } finally {
      await raw.membershipLocation.delete({ where: { id: stale.id } });
    }
  });

  it('DENTIST y RECEPTION no pueden leer ni cambiar sedes (403)', async () => {
    for (const token of [dentistaToken, recepcionToken]) {
      await api(a, token)
        .get(`/staff/${dentista.userId}/locations`)
        .expect(403);
      await api(a, token)
        .put(`/staff/${dentista.userId}/locations`, { locationIds: [] })
        .expect(403);
    }
  });

  it('desde otra clínica el miembro no existe (404) y no se escribe nada', async () => {
    const get = await api(b, b.adminToken)
      .get(`/staff/${recepcion.userId}/locations`)
      .expect(404);
    expect((get.body as { message: string }).message).toBe(
      STAFF_MEMBER_NOT_FOUND_MESSAGE,
    );
    await api(b, b.adminToken)
      .put(`/staff/${recepcion.userId}/locations`, { locationIds: [b1] })
      .expect(404);
    expect(await rowsOf(recepcion.userId)).toBe(1);
  });

  it('PUT [] le devuelve todas las sedes', async () => {
    await api(a, a.adminToken)
      .put(`/staff/${dentista.userId}/locations`, { locationIds: [a2] })
      .expect(200);
    const res = await api(a, a.adminToken)
      .put(`/staff/${dentista.userId}/locations`, { locationIds: [] })
      .expect(200);
    expect(res.body).toEqual({ all: true, locationIds: [] });
    expect(await rowsOf(dentista.userId)).toBe(0);
  });

  it('desactivar a un miembro conserva sus sedes', async () => {
    await api(a, a.adminToken)
      .put(`/staff/${dentista.userId}/locations`, { locationIds: [a2] })
      .expect(200);
    await api(a, a.adminToken).delete(`/staff/${dentista.userId}`).expect(204);
    expect(await rowsOf(dentista.userId)).toBe(1);
    // Desactivado: se puede consultar (su perfil sigue abriéndose), no cambiar.
    await api(a, a.adminToken)
      .get(`/staff/${dentista.userId}/locations`)
      .expect(200, { all: false, locationIds: [a2] });
    await api(a, a.adminToken)
      .put(`/staff/${dentista.userId}/locations`, { locationIds: [] })
      .expect(404);
  });

  it('ascender a ADMIN borra sus sedes: vuelve a tenerlas todas', async () => {
    await api(a, a.adminToken)
      .patch(`/staff/${recepcion.userId}`, { role: ClinicRole.ADMIN })
      .expect(200);
    expect(await rowsOf(recepcion.userId)).toBe(0);
    await api(a, a.adminToken)
      .get(`/staff/${recepcion.userId}/locations`)
      .expect(200, { all: true, locationIds: [] });
  });
});
