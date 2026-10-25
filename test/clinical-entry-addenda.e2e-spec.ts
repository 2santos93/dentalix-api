import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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

// DX-038 · historia clínica inalterable + adendas, de punta a punta: permisos
// por rol, IDOR entre clínicas y pacientes, autoría y fecha del servidor,
// orden cronológico, 405 a cualquier edición/borrado y rastro de auditoría
// sin el texto clínico. DIRECT_URL (superusuario) solo para leer y limpiar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REASON = 'Pieza dental mal transcrita';
const SECRET_TEXT = 'Texto-clinico-secreto-DX038';

interface Entry {
  id: string;
  notes: string;
  performedById: string;
  createdAt: string;
  addenda: Addendum[];
}

interface Addendum {
  id: string;
  patientId: string;
  clinicalEntryId: string;
  reason: string;
  text: string;
  authorId: string;
  createdAt: string;
}

describe('Adendas de la historia clínica (DX-038, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentistA: { token: string; userId: string };
  let assistantA: string;
  let receptionA: string;
  let patientA: string;
  let otherPatientA: string;
  let patientB: string;
  let entryA: Entry;
  let otherEntryA: Entry;
  let entryB: Entry;

  const http = () => request(app.getHttpServer());

  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  // Alta por `raw`: el flujo de alta (autorización de datos, documento) no
  // es lo que se prueba aquí.
  async function createPatient(clinic: Clinic, name: string): Promise<string> {
    const patient = await raw.patient.create({
      data: { tenantId: clinic.tenantId, firstName: name, lastName: 'Prueba' },
    });
    return patient.id;
  }

  async function createEntry(
    clinic: Clinic,
    patientId: string,
    token: string,
    notes: string,
  ): Promise<Entry> {
    const res = await call(
      clinic,
      'post',
      `/patients/${patientId}/clinical-entries`,
      token,
    )
      .send({ notes })
      .expect(201);
    return res.body as Entry;
  }

  const addendaPath = (patientId: string, entryId: string) =>
    `/patients/${patientId}/clinical-entries/${entryId}/addenda`;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx038-a');
    b = await registerClinic(app, 'dx038-b');
    const dentist = await seedMember(raw, a, 'DENTIST');
    dentistA = {
      token: await loginAs(app, a.host, dentist.email),
      userId: dentist.userId,
    };
    assistantA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, 'ASSISTANT')).email,
    );
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, 'RECEPTION')).email,
    );
    patientA = await createPatient(a, 'Ana');
    otherPatientA = await createPatient(a, 'Otra');
    patientB = await createPatient(b, 'Bea');
    entryA = await createEntry(a, patientA, dentistA.token, 'Resina en 46');
    otherEntryA = await createEntry(a, otherPatientA, a.adminToken, 'Control');
    entryB = await createEntry(b, patientB, b.adminToken, 'Profilaxis');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('la evolución la firma el usuario del JWT, aunque el cuerpo diga otra cosa', async () => {
    const res = await call(
      a,
      'post',
      `/patients/${patientA}/clinical-entries`,
      dentistA.token,
    )
      .send({
        notes: 'Nota',
        performedById: a.adminUserId,
        createdAt: '2001-01-01T00:00:00.000Z',
      })
      .expect(201);
    const body = res.body as Entry;
    expect(body.performedById).toBe(dentistA.userId);
    expect(new Date(body.createdAt).getFullYear()).toBeGreaterThan(2001);
    expect(body.addenda).toEqual([]);
  });

  describe('crear adenda', () => {
    it('DENTIST la crea: autor y fecha del servidor; el cliente no los falsea', async () => {
      const before = Date.now();
      const res = await call(
        a,
        'post',
        addendaPath(patientA, entryA.id),
        dentistA.token,
      )
        .send({
          reason: REASON,
          text: SECRET_TEXT,
          authorId: a.adminUserId,
          createdAt: '2001-01-01T00:00:00.000Z',
          tenantId: b.tenantId,
        })
        .expect(201);
      const body = res.body as Addendum;
      expect(body).toMatchObject({
        patientId: patientA,
        clinicalEntryId: entryA.id,
        reason: REASON,
        text: SECRET_TEXT,
        authorId: dentistA.userId,
      });
      expect(new Date(body.createdAt).getTime()).toBeGreaterThanOrEqual(
        before - 60_000,
      );
    });

    it('ASSISTANT y ADMIN también (roles clínicos)', async () => {
      for (const token of [assistantA, a.adminToken]) {
        await call(a, 'post', addendaPath(patientA, entryA.id), token)
          .send({ reason: REASON, text: 'Otra aclaración' })
          .expect(201);
      }
    });

    it('RECEPTION no puede (403) ni leerlas', async () => {
      await call(a, 'post', addendaPath(patientA, entryA.id), receptionA)
        .send({ reason: REASON, text: 'x' })
        .expect(403);
      await call(a, 'get', addendaPath(patientA, entryA.id), receptionA).expect(
        403,
      );
    });

    it.each([
      ['sin motivo', { text: 'x' }],
      ['motivo corto', { reason: 'corto', text: 'x' }],
      ['motivo en blanco', { reason: '            ', text: 'x' }],
      ['motivo demasiado largo', { reason: 'm'.repeat(501), text: 'x' }],
      ['sin texto', { reason: REASON }],
      ['texto demasiado largo', { reason: REASON, text: 't'.repeat(5001) }],
    ])('%s → 400', async (_label, body) => {
      await call(a, 'post', addendaPath(patientA, entryA.id), dentistA.token)
        .send(body)
        .expect(400);
    });

    it('IDOR: evolución de otra clínica → 404, sin crear nada', async () => {
      await call(a, 'post', addendaPath(patientA, entryB.id), dentistA.token)
        .send({ reason: REASON, text: 'x' })
        .expect(404);
      await call(a, 'post', addendaPath(patientB, entryB.id), dentistA.token)
        .send({ reason: REASON, text: 'x' })
        .expect(404);
      expect(
        await raw.clinicalEntryAddendum.count({
          where: { clinicalEntryId: entryB.id },
        }),
      ).toBe(0);
    });

    it('IDOR: evolución de otro paciente de la misma clínica → 404', async () => {
      const res = await call(
        a,
        'post',
        addendaPath(patientA, otherEntryA.id),
        dentistA.token,
      )
        .send({ reason: REASON, text: 'x' })
        .expect(404);
      expect((res.body as { message: string }).message).toMatch(
        /Evolución no encontrada/,
      );
    });
  });

  describe('listar', () => {
    it('las adendas salen con su evolución, en orden cronológico, y el original intacto', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${patientA}/clinical-entries`,
        dentistA.token,
      ).expect(200);
      const entry = (res.body as Entry[]).find((e) => e.id === entryA.id)!;
      expect(entry.notes).toBe('Resina en 46');
      expect(entry.addenda.map((x) => x.text)).toEqual([
        SECRET_TEXT,
        'Otra aclaración',
        'Otra aclaración',
      ]);
      const times = entry.addenda.map((x) => new Date(x.createdAt).getTime());
      expect([...times].sort((x, y) => x - y)).toEqual(times);

      const own = await call(
        a,
        'get',
        addendaPath(patientA, entryA.id),
        assistantA,
      ).expect(200);
      expect((own.body as Addendum[]).map((x) => x.id)).toEqual(
        entry.addenda.map((x) => x.id),
      );
    });

    it('otra clínica no las ve (404)', async () => {
      await call(
        b,
        'get',
        addendaPath(patientA, entryA.id),
        b.adminToken,
      ).expect(404);
    });
  });

  describe('una evolución no se edita ni se borra', () => {
    it.each(['patch', 'put', 'delete'] as const)(
      '%s → 405 con mensaje que remite a la adenda',
      async (verb) => {
        const res = await call(
          a,
          verb,
          `/patients/${patientA}/clinical-entries/${entryA.id}`,
          dentistA.token,
        )
          .send({ notes: 'alterado' })
          .expect(405);
        expect((res.body as { message: string }).message).toMatch(/adenda/);
      },
    );

    it('la evolución sigue igual', async () => {
      const row = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: entryA.id },
      });
      expect(row.notes).toBe('Resina en 46');
    });
  });

  it('el registro de auditoría guarda la creación sin el texto clínico', async () => {
    const created = await raw.clinicalEntryAddendum.findFirstOrThrow({
      where: { text: SECRET_TEXT },
    });
    const events = await raw.auditEvent.findMany({
      where: {
        resourceType: 'CLINICAL_ENTRY_ADDENDUM',
        action: 'CREATE',
        resourceId: created.id,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: a.tenantId,
      actorUserId: dentistA.userId,
      patientId: patientA,
    });
    expect(JSON.stringify(events[0])).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(events[0])).not.toContain(REASON);
  });
});
