import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
import { seedIcd10Codes } from '../src/modules/reference/infrastructure/seed-icd10-codes';
import { civilDateIn } from '../src/shared/time/civil-day';

// DX-212 · códigos clínicos de punta a punta: búsqueda CIE-10, evolución con
// diagnósticos por rol, REPS solo ADMIN (auditado), sede de la evolución
// (DX-232) y aislamiento entre clínicas. DX-318/DX-320: ya no existen la
// preparación RDA ni el código CUPS del catálogo. DIRECT_URL solo lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
interface CatalogItem {
  id: string;
  code: string;
  labelEs: string;
  kind: string;
}
interface Location {
  id: string;
  country: string;
  repsHabilitationCode: string | null;
}

describe('Códigos clínicos: CIE-10 y REPS (DX-212, e2e)', () => {
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
          lastName: 'Códigos',
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

    it('DX-236: la ficha conserva el diagnóstico tras cambiar su referencia', async () => {
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

  describe('REPS de la sede (solo ADMIN, auditado)', () => {
    it('formato inválido da 400 con el formato esperado', async () => {
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

    it('DENTIST y RECEPTION no pueden editarlo (403)', async () => {
      for (const token of [dentist.token, reception]) {
        await call(a, 'patch', `/locations/${location.id}`, token)
          .send({ repsHabilitationCode: '110010123401' })
          .expect(403);
      }
    });

    it('ADMIN lo guarda; queda auditado con el campo cambiado', async () => {
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
          resourceType: 'LOCATION',
        },
      });
      expect(
        events.map((e) => [
          e.resourceId,
          (e.metadata as { changedFields?: string[] }).changedFields,
        ]),
      ).toContainEqual([location.id, ['repsHabilitationCode']]);
    });
  });

  // DX-320 (decisión D4): el catálogo no tiene código CUPS ni ningún «código
  // externo»; basta su código interno. Un cliente antiguo que aún lo mande ve
  // el campo descartado por la ValidationPipe global (whitelist), como
  // cualquier campo desconocido: no se guarda ni se devuelve.
  describe('DX-320: el catálogo no tiene código CUPS', () => {
    it('el listado no devuelve cupsCode', async () => {
      const res = await call(
        a,
        'get',
        '/catalog/items?kind=PROCEDURE',
        a.adminToken,
      ).expect(200);
      for (const item of res.body as Record<string, unknown>[]) {
        expect(item).not.toHaveProperty('cupsCode');
      }
    });

    it('POST con cupsCode: el campo se descarta (ni se guarda ni se devuelve)', async () => {
      const res = await call(a, 'post', '/catalog/items', a.adminToken)
        .send({
          code: 'DX320-PROC',
          labelEs: 'Procedimiento DX-320',
          kind: 'PROCEDURE',
          color: '#0E7490',
          cupsCode: '232101',
        })
        .expect(201);
      expect((res.body as CatalogItem).code).toBe('DX320-PROC');
      expect(res.body).not.toHaveProperty('cupsCode');
    });

    it('PATCH con cupsCode: el campo se descarta; el resto del cambio se aplica', async () => {
      const res = await call(
        a,
        'patch',
        `/catalog/items/${procedure.id}`,
        a.adminToken,
      )
        .send({ labelEs: `${procedure.labelEs} (DX-320)`, cupsCode: '232101' })
        .expect(200);
      expect((res.body as CatalogItem).labelEs).toBe(
        `${procedure.labelEs} (DX-320)`,
      );
      expect(res.body).not.toHaveProperty('cupsCode');
      await call(a, 'patch', `/catalog/items/${procedure.id}`, a.adminToken)
        .send({ labelEs: procedure.labelEs })
        .expect(200);
    });

    it('la columna ya no existe en la base de datos', async () => {
      const columns = await raw.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'dental_catalog_items' AND column_name = 'cupsCode'`;
      expect(columns).toEqual([]);
    });
  });

  // DX-318: el indicador de preparación para el RDA ya no existe.
  describe('DX-318: sin preparación RDA', () => {
    let entryId: string;

    beforeAll(async () => {
      entryId = (
        (
          await createEntry(dentist.token, {
            diagnoses: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL' }],
          }).expect(201)
        ).body as Entry
      ).id;
    });

    it('GET /clinical-entries/:id/rda-readiness responde 404', async () => {
      await call(
        a,
        'get',
        `/clinical-entries/${entryId}/rda-readiness`,
        dentist.token,
      ).expect(404);
    });

    it('GET /patients/:patientId/clinical-entries/rda-readiness responde 404', async () => {
      await call(
        a,
        'get',
        `${entries(patient)}/rda-readiness?ids=${entryId}`,
        dentist.token,
      ).expect(404);
    });

    it('el contrato OpenAPI no la describe ni el catálogo lleva cupsCode', () => {
      const swagger = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(
        Object.keys(swagger.paths).filter((path) => /rda/i.test(path)),
      ).toEqual([]);
      expect(Object.keys(swagger.components?.schemas ?? {})).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/Rda/)]),
      );
      for (const dto of [
        'DentalCatalogItemDto',
        'CreateCatalogItemDto',
        'UpdateCatalogItemDto',
      ]) {
        const schema = swagger.components?.schemas?.[dto] as
          { properties?: Record<string, unknown> } | undefined;
        expect(schema?.properties).toBeDefined();
        expect(schema?.properties).not.toHaveProperty('cupsCode');
      }
    });
  });

  describe('DX-232: sede de la evolución', () => {
    it('sin cita en la sede B guarda B; la cita prevalece sobre la cabecera', async () => {
      const second = await raw.location.create({
        data: { tenantId: a.tenantId, name: 'Sede B DX232' },
      });
      const res = await createEntry(dentist.token, {})
        .set('X-Location-Id', second.id)
        .expect(201);
      const id = (res.body as Entry).id;
      expect(
        (await raw.clinicalEntry.findUniqueOrThrow({ where: { id } }))
          .locationId,
      ).toBe(second.id);
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

    it('B no puede editar un ítem del catálogo de A ni poner el REPS de una sede de A (404)', async () => {
      await call(b, 'patch', `/catalog/items/${procedure.id}`, b.adminToken)
        .send({ labelEs: 'Ajeno' })
        .expect(404);
      await call(b, 'patch', `/locations/${location.id}`, b.adminToken)
        .send({ repsHabilitationCode: '110010123401' })
        .expect(404);
    });
  });
});
