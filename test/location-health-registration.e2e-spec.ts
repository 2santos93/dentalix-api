import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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

// DX-319: la sede ya no tiene código REPS y gana un nº de registro sanitario
// libre (sin formato por país) y si sale en los documentos. Solo ADMIN lo
// edita; queda auditado con su antes y después; otra clínica no llega a la
// sede (404) y un cliente que aún envíe el REPS recibe 400.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LocationBody {
  id: string;
  name: string;
  healthRegistrationNumber: string | null;
  showHealthRegistrationNumber: boolean;
  repsHabilitationCode?: unknown;
}

describe('Nº de registro sanitario de la sede (DX-319, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let location: LocationBody;
  const tokens: Partial<Record<ClinicRole, string>> = {};

  const patch = (clinic: Clinic, token: string, id: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1/locations/${id}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const list = (clinic: Clinic, token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/locations')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx319-a');
    b = await registerClinic(app, 'dx319-b');
    for (const role of ['DENTIST', 'ASSISTANT', 'RECEPTION'] as const) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    location = (
      (await list(a, a.adminToken).expect(200)).body as LocationBody[]
    )[0];
  }, 60_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la sede nace sin nº, sin imprimirlo y sin campo REPS en la respuesta', () => {
    expect(location.healthRegistrationNumber).toBeNull();
    expect(location.showHealthRegistrationNumber).toBe(false);
    expect(location).not.toHaveProperty('repsHabilitationCode');
  });

  it('ADMIN lo edita (texto libre recortado) → 200 y auditado con antes y después', async () => {
    const saved = await patch(a, a.adminToken, location.id, {
      healthRegistrationNumber: '  NRS 28/1234-AB  ',
      showHealthRegistrationNumber: true,
    }).expect(200);
    expect(saved.body).toMatchObject({
      id: location.id,
      healthRegistrationNumber: 'NRS 28/1234-AB',
      showHealthRegistrationNumber: true,
    });
    expect(saved.body).not.toHaveProperty('repsHabilitationCode');

    // Otro cambio de sede que no lo toca: no lo cambia ni trae antes/después.
    const renamed = await patch(a, a.adminToken, location.id, {
      name: 'Sede Centro',
    }).expect(200);
    expect(renamed.body).toMatchObject({
      healthRegistrationNumber: 'NRS 28/1234-AB',
      showHealthRegistrationNumber: true,
    });

    // Vaciarlo lo quita.
    const cleared = await patch(a, a.adminToken, location.id, {
      healthRegistrationNumber: '   ',
    }).expect(200);
    expect((cleared.body as LocationBody).healthRegistrationNumber).toBeNull();
    const row = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(row.healthRegistrationNumber).toBeNull();
    expect(row.showHealthRegistrationNumber).toBe(true);

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        action: 'UPDATE',
        resourceType: 'LOCATION',
        resourceId: location.id,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.metadata)).toEqual([
      {
        changedFields: [
          'healthRegistrationNumber',
          'showHealthRegistrationNumber',
        ],
        params: { id: location.id },
        healthRegistration: {
          before: { number: null, shown: false },
          after: { number: 'NRS 28/1234-AB', shown: true },
        },
      },
      { changedFields: ['name'], params: { id: location.id } },
      {
        changedFields: ['healthRegistrationNumber'],
        params: { id: location.id },
        healthRegistration: {
          before: { number: 'NRS 28/1234-AB', shown: true },
          after: { number: null, shown: true },
        },
      },
    ]);
    expect(events.every((e) => e.actorUserId === a.adminUserId)).toBe(true);
  });

  it('más de 64 caracteres o un tipo que no es texto → 400', async () => {
    const tooLong = await patch(a, a.adminToken, location.id, {
      healthRegistrationNumber: 'A'.repeat(65),
    }).expect(400);
    expect(JSON.stringify(tooLong.body)).toContain(
      'El nº de registro sanitario admite hasta 64 caracteres.',
    );
    await patch(a, a.adminToken, location.id, {
      healthRegistrationNumber: 1234,
    }).expect(400);
    await patch(a, a.adminToken, location.id, {
      showHealthRegistrationNumber: 'sí',
    }).expect(400);
  });

  it('caracteres de control o de formato y la casilla a null → 400 en español, nada cambia (revisión)', async () => {
    const before = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    for (const value of ['A\tB', 'A\nB', 'A\u0000B', 'A\u202EB']) {
      const res = await patch(a, a.adminToken, location.id, {
        healthRegistrationNumber: value,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'no admite saltos de línea ni caracteres de control',
      );
    }
    const nullShow = await patch(a, a.adminToken, location.id, {
      showHealthRegistrationNumber: null,
    }).expect(400);
    expect(JSON.stringify(nullShow.body)).toContain(
      '«Mostrar en los documentos» debe ser verdadero o falso.',
    );
    const after = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(after.healthRegistrationNumber).toBe(
      before.healthRegistrationNumber,
    );
    expect(after.showHealthRegistrationNumber).toBe(
      before.showHealthRegistrationNumber,
    );
  });

  it('el campo REPS en el cuerpo → 400 y no cambia nada', async () => {
    const before = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    for (const value of ['110010123401', null]) {
      const res = await patch(a, a.adminToken, location.id, {
        name: 'Con REPS',
        repsHabilitationCode: value,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain('El código REPS ya no existe');
    }
    const after = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(after.name).toBe(before.name);
  });

  it.each(['DENTIST', 'ASSISTANT', 'RECEPTION'] as const)(
    '%s no puede editarlo (403) pero sí lo lee',
    async (role) => {
      const token = tokens[role] as string;
      await patch(a, token, location.id, {
        healthRegistrationNumber: 'NRS-X',
        showHealthRegistrationNumber: false,
      }).expect(403);
      const seen = (await list(a, token).expect(200)).body as LocationBody[];
      expect(seen[0]).toHaveProperty('healthRegistrationNumber', null);
      expect(seen[0]).toHaveProperty('showHealthRegistrationNumber', true);
    },
  );

  it('el ADMIN de otra clínica no llega a la sede (404) y no la cambia', async () => {
    const auditOfLocation = () =>
      raw.auditEvent.findMany({
        where: { resourceType: 'LOCATION', resourceId: location.id },
        orderBy: { occurredAt: 'asc' },
        select: { id: true, tenantId: true },
      });
    const eventsBefore = await auditOfLocation();
    expect(eventsBefore.length).toBeGreaterThan(0);
    await patch(b, b.adminToken, location.id, {
      healthRegistrationNumber: 'Hackeada',
      showHealthRegistrationNumber: false,
    }).expect(404);
    const row = await raw.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(row.healthRegistrationNumber).toBeNull();
    expect(row.showHealthRegistrationNumber).toBe(true);
    // El intento de B no deja evento sobre la sede (ni en A ni en B).
    const eventsAfter = await auditOfLocation();
    expect(eventsAfter).toEqual(eventsBefore);
    expect(eventsAfter.every((e) => e.tenantId === a.tenantId)).toBe(true);
  });
});
