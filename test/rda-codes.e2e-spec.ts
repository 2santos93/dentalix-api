import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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
import { seedIcd10Codes } from '../src/modules/reference/infrastructure/seed-icd10-codes';
import { civilDateIn } from '../src/shared/time/civil-day';

// DX-212 · códigos para el RDA de punta a punta: búsqueda CIE-10, evolución con
// diagnósticos por rol, CUPS y REPS solo ADMIN (auditados), rda-readiness en
// sede CO y ES y aislamiento entre clínicas. DIRECT_URL solo lee y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Diagnosis {
  icd10Code: string;
  labelEs: string;
  kind: string;
  toothFdi: string | null;
}
interface Entry {
  id: string;
  diagnoses: Diagnosis[];
}
interface Readiness {
  notApplicable: boolean;
  ready: boolean;
  missing: { code: string; label: string; resourceId: string | null }[];
  pending: { code: string; reason: string }[];
}
interface CatalogItem {
  id: string;
  labelEs: string;
  kind: string;
  cupsCode: string | null;
}
interface Location {
  id: string;
  country: string;
  repsHabilitationCode: string | null;
}

describe('Códigos RDA: CIE-10, CUPS y REPS (DX-212, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let assistant: string;
  let reception: string;
  let patient: string;
  let patientB: string;
  let procedure: CatalogItem;
  let location: Location;

  const http = () => request(app.getHttpServer());
  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'patch',
    path: string,
    token: string,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  /** Hoy en Bogotá como fecha civil (lo que manda la web al elegir fecha). */
  const today = () =>
    `${civilDateIn(new Date(), 'America/Bogota')}T00:00:00.000Z`;

  const entries = (p: string) => `/patients/${p}/clinical-entries`;

  function createEntry(
    token: string,
    body: Record<string, unknown>,
    clinic: Clinic = a,
    p: string = patient,
  ) {
    return call(clinic, 'post', entries(p), token).send({
      notes: 'Resina oclusal',
      entryDate: today(),
      ...body,
    });
  }

  const readiness = (clinic: Clinic, id: string, token: string) =>
    call(clinic, 'get', `/clinical-entries/${id}/rda-readiness`, token);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await seedIcd10Codes(raw);
    a = await registerClinic(app, 'dx212-a');
    b = await registerClinic(app, 'dx212-b');
    const d = await seedMember(raw, a, 'DENTIST');
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, 'ASSISTANT')).email,
    );
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, 'RECEPTION')).email,
    );
    patient = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Ana',
          lastName: 'RDA',
          docNumber: '1020304050',
        },
      })
    ).id;
    patientB = (
      await raw.patient.create({
        data: { tenantId: b.tenantId, firstName: 'Bea', lastName: 'Otra' },
      })
    ).id;
    const catalog = await call(
      a,
      'get',
      '/catalog/items?kind=PROCEDURE',
      a.adminToken,
    ).expect(200);
    procedure = (catalog.body as CatalogItem[])[0];
    const locations = await call(a, 'get', '/locations', a.adminToken).expect(
      200,
    );
    location = (locations.body as Location[])[0];
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('GET /reference/icd10', () => {
    it('«caries» da como mucho 20 coincidencias, en menos de 300 ms', async () => {
      const started = Date.now();
      const res = await call(
        a,
        'get',
        '/reference/icd10?q=caries',
        dentist.token,
      ).expect(200);
      expect(Date.now() - started).toBeLessThan(300);
      const codes = res.body as { code: string; labelEs: string }[];
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.length).toBeLessThanOrEqual(20);
      expect(codes.every((c) => /caries/i.test(c.labelEs))).toBe(true);
    });

    it('«K02», «k021» y sin tildes («exposicion») encuentran por código o texto', async () => {
      const k02 = await call(a, 'get', '/reference/icd10?q=K02', dentist.token);
      const k02codes = (k02.body as { code: string }[]).map((c) => c.code);
      expect(k02codes[0]).toBe('K02.0');
      expect(k02codes.every((c) => c.startsWith('K02'))).toBe(true);
      const k021 = await call(
        a,
        'get',
        '/reference/icd10?q=k021',
        dentist.token,
      );
      expect((k021.body as { code: string }[])[0].code).toBe('K02.1');
      const accent = await call(
        a,
        'get',
        '/reference/icd10?q=exposicion',
        dentist.token,
      );
      expect((accent.body as { code: string }[]).map((c) => c.code)).toEqual([
        'K02.5',
      ]);
    });

    it('sin texto, los 20 primeros; con texto sin coincidencias, vacío', async () => {
      const all = await call(a, 'get', '/reference/icd10', dentist.token);
      expect(all.body).toHaveLength(20);
      const none = await call(
        a,
        'get',
        '/reference/icd10?q=zzzz',
        dentist.token,
      );
      expect(none.body).toEqual([]);
    });

    it('sin sesión, 401', async () => {
      await http()
        .get('/api/v1/reference/icd10?q=caries')
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('evolución con diagnósticos', () => {
    let entry: Entry;

    it('DENTIST registra K02.1 principal y K05.1 relacionado en el 36; la ficha los muestra con texto', async () => {
      const res = await createEntry(dentist.token, {
        diagnoses: [
          { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
          { icd10Code: 'K05.1', kind: 'RELACIONADO', toothFdi: '36' },
        ],
      }).expect(201);
      entry = res.body as Entry;
      const list = await call(a, 'get', entries(patient), dentist.token).expect(
        200,
      );
      const listed = (list.body as Entry[]).find((e) => e.id === entry.id);
      expect(listed?.diagnoses).toEqual([
        expect.objectContaining({
          icd10Code: 'K02.1',
          labelEs: 'Caries de la dentina',
          kind: 'PRINCIPAL',
          toothFdi: null,
        }),
        expect.objectContaining({
          icd10Code: 'K05.1',
          labelEs: 'Gingivitis crónica',
          kind: 'RELACIONADO',
          toothFdi: '36',
        }),
      ]);
    });

    it('DX-236: ficha y preparación RDA conservan el diagnóstico tras cambiar su referencia', async () => {
      const before = await readiness(a, entry.id, dentist.token).expect(200);
      await raw.icd10Code.update({
        where: { code: 'K02.1' },
        data: { labelEs: 'Referencia corregida posteriormente' },
      });
      try {
        const list = await call(
          a,
          'get',
          entries(patient),
          dentist.token,
        ).expect(200);
        const saved = (list.body as Entry[]).find((e) => e.id === entry.id);
        expect(saved?.diagnoses[0].labelEs).toBe('Caries de la dentina');
        const after = await readiness(a, entry.id, dentist.token).expect(200);
        expect(after.body).toEqual(before.body);
      } finally {
        await raw.icd10Code.update({
          where: { code: 'K02.1' },
          data: { labelEs: 'Caries de la dentina' },
        });
      }
    });

    it('la evolución con diagnósticos no se edita ni se borra (405)', async () => {
      await call(
        a,
        'patch',
        `${entries(patient)}/${entry.id}`,
        dentist.token,
      ).expect(405);
    });

    it('un segundo PRINCIPAL da 400 en español y no guarda la evolución', async () => {
      const before = await raw.clinicalEntry.count({
        where: { tenantId: a.tenantId },
      });
      const res = await createEntry(dentist.token, {
        diagnoses: [
          { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
          { icd10Code: 'K05.1', kind: 'PRINCIPAL' },
        ],
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Solo puede haber un diagnóstico principal por evolución',
      );
      expect(
        await raw.clinicalEntry.count({ where: { tenantId: a.tenantId } }),
      ).toBe(before);
    });

    it('un código inexistente da 400 «Código CIE-10 no válido»', async () => {
      const res = await createEntry(dentist.token, {
        diagnoses: [{ icd10Code: 'K99.9', kind: 'PRINCIPAL' }],
      }).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /^Código CIE-10 no válido/,
      );
    });

    it('ASSISTANT y ADMIN también; RECEPTION no (403) ni ve la ficha clínica', async () => {
      for (const token of [assistant, a.adminToken]) {
        await createEntry(token, {
          diagnoses: [{ icd10Code: 'Z01.2', kind: 'PRINCIPAL' }],
        }).expect(201);
      }
      await createEntry(reception, {
        diagnoses: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL' }],
      }).expect(403);
      await call(a, 'get', entries(patient), reception).expect(403);
      await readiness(a, entry.id, reception).expect(403);
    });

    it('sin diagnóstico sigue permitida', async () => {
      const res = await createEntry(dentist.token, {}).expect(201);
      expect((res.body as Entry).diagnoses).toEqual([]);
    });

    it('el alta (evolución y diagnósticos, un solo asiento) queda auditada sin el contenido clínico', async () => {
      const event = await raw.auditEvent.findFirst({
        where: {
          tenantId: a.tenantId,
          action: 'CREATE',
          resourceType: 'CLINICAL_ENTRY',
          resourceId: entry.id,
        },
      });
      expect(event?.patientId).toBe(patient);
      expect(event?.actorUserId).toBe(dentist.userId);
      expect(JSON.stringify(event?.metadata)).not.toContain('K02.1');
    });
  });

  describe('CUPS del catálogo y REPS de la sede (solo ADMIN, auditados)', () => {
    it('formatos inválidos dan 400 con el formato esperado', async () => {
      const cups = await call(
        a,
        'patch',
        `/catalog/items/${procedure.id}`,
        a.adminToken,
      )
        .send({ cupsCode: '89-20' })
        .expect(400);
      expect((cups.body as { message: string }).message).toMatch(
        /6 caracteres alfanuméricos/,
      );
      const reps = await call(
        a,
        'patch',
        `/locations/${location.id}`,
        a.adminToken,
      )
        .send({ repsHabilitationCode: '123' })
        .expect(400);
      expect((reps.body as { message: string }).message).toMatch(/12 dígitos/);
    });

    it('DENTIST y RECEPTION no pueden editarlos (403)', async () => {
      for (const token of [dentist.token, reception]) {
        await call(a, 'patch', `/catalog/items/${procedure.id}`, token)
          .send({ cupsCode: '232101' })
          .expect(403);
        await call(a, 'patch', `/locations/${location.id}`, token)
          .send({ repsHabilitationCode: '110010123401' })
          .expect(403);
      }
    });

    it('ADMIN los guarda; quedan auditados con el campo cambiado', async () => {
      const item = await call(
        a,
        'patch',
        `/catalog/items/${procedure.id}`,
        a.adminToken,
      )
        .send({ cupsCode: '232101' })
        .expect(200);
      expect((item.body as CatalogItem).cupsCode).toBe('232101');
      const loc = await call(
        a,
        'patch',
        `/locations/${location.id}`,
        a.adminToken,
      )
        .send({ repsHabilitationCode: '110010123401' })
        .expect(200);
      expect((loc.body as Location).repsHabilitationCode).toBe('110010123401');

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          action: 'UPDATE',
          resourceType: { in: ['DENTAL_CATALOG_ITEM', 'LOCATION'] },
        },
      });
      expect(
        events.map((e) => [
          e.resourceType,
          e.resourceId,
          (e.metadata as { changedFields?: string[] }).changedFields,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['DENTAL_CATALOG_ITEM', procedure.id, ['cupsCode']],
          ['LOCATION', location.id, ['repsHabilitationCode']],
        ]),
      );
      // Quitar el CUPS para el bloque de rda-readiness.
      await call(a, 'patch', `/catalog/items/${procedure.id}`, a.adminToken)
        .send({ cupsCode: null })
        .expect(200);
    });
  });

  describe('GET /clinical-entries/:id/rda-readiness', () => {
    let entryId: string;

    beforeAll(async () => {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: dentist.userId },
        data: { professionalLicense: 'TP-12345' },
      });
      const res = await createEntry(dentist.token, {
        diagnoses: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: '36' }],
      }).expect(201);
      entryId = (res.body as Entry).id;
      // Procedimiento hecho en esta clínica hoy (odontograma).
      await call(a, 'post', `/patients/${patient}/tooth-records`, dentist.token)
        .send({
          toothNumber: '36',
          surfaces: ['OCCLUSAL'],
          kind: 'PROCEDURE',
          catalogItemId: procedure.id,
          status: 'COMPLETED',
        })
        .expect(201);
    });

    it('si falta el CUPS de un ítem realizado, sale con el nombre del ítem', async () => {
      const res = await readiness(a, entryId, dentist.token).expect(200);
      const body = res.body as Readiness;
      expect(body.ready).toBe(false);
      expect(body.missing).toEqual([
        {
          code: 'PROCEDURE_CUPS',
          label: `Código CUPS de «${procedure.labelEs}»`,
          resourceId: procedure.id,
        },
      ]);
    });

    it('con el CUPS puesto: ready (el NIT queda pendiente de DX-019)', async () => {
      await call(a, 'patch', `/catalog/items/${procedure.id}`, a.adminToken)
        .send({ cupsCode: '232101' })
        .expect(200);
      const res = await readiness(a, entryId, assistant).expect(200);
      expect(res.body).toEqual({
        notApplicable: false,
        ready: true,
        missing: [],
        pending: [
          {
            code: 'CLINIC_TAX_ID',
            label: 'NIT de la clínica',
            reason: 'pendiente de DX-019',
          },
        ],
      });
    });

    it('una evolución antigua sin diagnóstico responde sin error, con el diagnóstico como faltante', async () => {
      const old = await raw.clinicalEntry.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient,
          entryDate: new Date('2025-01-10T00:00:00.000Z'),
          notes: 'Nota anterior a DX-212',
          performedById: dentist.userId,
        },
      });
      const res = await readiness(a, old.id, dentist.token).expect(200);
      const body = res.body as Readiness;
      expect(body.ready).toBe(false);
      expect(body.missing.map((m) => m.code)).toEqual(['PRINCIPAL_DIAGNOSIS']);
    });

    it('en una sede ES no aplica', async () => {
      await call(a, 'patch', `/locations/${location.id}`, a.adminToken)
        .send({ country: 'ES' })
        .expect(200);
      try {
        const res = await readiness(a, entryId, dentist.token).expect(200);
        expect(res.body).toEqual({
          notApplicable: true,
          ready: false,
          missing: [],
          pending: [],
        });
      } finally {
        await call(a, 'patch', `/locations/${location.id}`, a.adminToken)
          .send({ country: 'CO' })
          .expect(200);
      }
    });

    it('la consulta queda auditada con el paciente', async () => {
      const event = await raw.auditEvent.findFirst({
        where: {
          tenantId: a.tenantId,
          action: 'VIEW',
          resourceId: entryId,
        },
      });
      expect(event?.patientId).toBe(patient);
      expect((event?.metadata as { reason?: string }).reason).toBe(
        'RDA_READINESS',
      );
    });
  });

  describe('DX-232: readiness por lotes y sede persistida', () => {
    it('40 evoluciones: una respuesta equivalente y un único evento de auditoría', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        ids.push(
          ((await createEntry(dentist.token, {}).expect(201)).body as Entry).id,
        );
      }
      const expected = (await readiness(a, ids[0], dentist.token).expect(200))
        .body as Readiness;
      const before = await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          action: 'VIEW',
          metadata: { path: ['reason'], equals: 'RDA_READINESS' },
        },
      });
      const res = await call(
        a,
        'get',
        `${entries(patient)}/rda-readiness?ids=${ids.join(',')}`,
        dentist.token,
      ).expect(200);
      expect(res.body).toEqual(
        ids.map((entryId) => ({ entryId, ...expected })),
      );
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          action: 'VIEW',
          metadata: { path: ['reason'], equals: 'RDA_READINESS' },
        },
      });
      expect(events).toHaveLength(before + 1);
      const batch = events.find(
        (e) => e.resourceId === null && e.patientId === patient,
      );
      expect(batch?.actorUserId).toBe(dentist.userId);
      expect(JSON.stringify(batch?.metadata)).not.toContain(ids[0]);
    });
    it('400 por51 IDs, vacío o inválido;403 recepción y404 si cualquier id es ajeno', async () => {
      const own = (
        (await createEntry(dentist.token, {}).expect(201)).body as Entry
      ).id;
      const foreign = (
        (await createEntry(b.adminToken, {}, b, patientB).expect(201))
          .body as Entry
      ).id;
      const endpoint = `${entries(patient)}/rda-readiness?ids=`;
      await call(
        a,
        'get',
        endpoint + Array(51).fill(own).join(','),
        dentist.token,
      ).expect(400);
      await call(a, 'get', endpoint, dentist.token).expect(400);
      await call(a, 'get', endpoint + 'invalid', dentist.token).expect(400);
      await call(a, 'get', endpoint + own, reception).expect(403);
      await call(
        a,
        'get',
        endpoint + [own, foreign].join(','),
        dentist.token,
      ).expect(404);
      const other = await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Otro', lastName: 'Paciente' },
      });
      await call(
        a,
        'get',
        `${entries(other.id)}/rda-readiness?ids=${own}`,
        dentist.token,
      ).expect(404);
      await call(b, 'get', endpoint + own, b.adminToken).expect(404);
    });
    it('sin cita en sedeB guarda B y usa su REPS; la cita prevalece sobre la cabecera', async () => {
      const second = await raw.location.create({
        data: {
          tenantId: a.tenantId,
          name: 'Sede B DX232',
          repsHabilitationCode: null,
        },
      });
      const res = await createEntry(dentist.token, {})
        .set('X-Location-Id', second.id)
        .expect(201);
      const id = (res.body as Entry).id;
      expect(
        (await raw.clinicalEntry.findUniqueOrThrow({ where: { id } }))
          .locationId,
      ).toBe(second.id);
      const read = await readiness(a, id, dentist.token).expect(200);
      expect((read.body as Readiness).missing).toContainEqual({
        code: 'LOCATION_REPS',
        label: 'Código de habilitación (REPS) de «Sede B DX232»',
        resourceId: second.id,
      });
      const appointment = await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient,
          providerId: dentist.userId,
          locationId: location.id,
          start: new Date(),
          end: new Date(Date.now() + 1800000),
          status: 'CONFIRMED',
        },
      });
      const linked = await createEntry(dentist.token, {
        appointmentId: appointment.id,
      })
        .set('X-Location-Id', second.id)
        .expect(201);
      expect(
        (
          await raw.clinicalEntry.findUniqueOrThrow({
            where: { id: (linked.body as Entry).id },
          })
        ).locationId,
      ).toBe(location.id);
    });
  });

  describe('aislamiento entre clínicas', () => {
    let entryA: string;

    beforeAll(async () => {
      const res = await createEntry(dentist.token, {
        diagnoses: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL' }],
      }).expect(201);
      entryA = (res.body as Entry).id;
    });

    it('la clínica B no ve la preparación RDA de una evolución de A (404)', async () => {
      await readiness(b, entryA, b.adminToken).expect(404);
    });

    it('B no puede registrar una evolución en un paciente de A (404) y A no ve las de B', async () => {
      await createEntry(
        b.adminToken,
        { diagnoses: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL' }] },
        b,
        patient,
      ).expect(404);
      await createEntry(b.adminToken, {}, b, patientB).expect(201);
      const seen = await call(a, 'get', entries(patientB), a.adminToken);
      expect(seen.body).toEqual([]);
    });

    it('B no puede poner el CUPS de un ítem de A ni el REPS de una sede de A (404)', async () => {
      await call(b, 'patch', `/catalog/items/${procedure.id}`, b.adminToken)
        .send({ cupsCode: '890203' })
        .expect(404);
      await call(b, 'patch', `/locations/${location.id}`, b.adminToken)
        .send({ repsHabilitationCode: '110010123401' })
        .expect(404);
    });
  });
});
