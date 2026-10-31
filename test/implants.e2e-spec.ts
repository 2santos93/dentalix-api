import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-191 · Registro de implantes, tarjeta imprimible y búsqueda por lote.
// Todo por la API; `raw` (DIRECT_URL) solo lee la auditoría y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const LOT = 'LOT-RECALL-01';

interface ImplantBody {
  id: string;
  toothNumber: string;
  kind: string;
  reference: string;
  lot: string;
  professionalId: string;
  voidedAt: string | null;
  voidReason: string | null;
}

interface CardBody {
  patientName: string;
  patientDocument: string | null;
  clinicName: string;
  locations: { name: string }[];
  placedOn: string;
  professionals: string[];
  items: {
    id: string;
    kindLabel: string;
    reference: string;
    lot: string;
    voided: boolean;
  }[];
  deliveredAt: string | null;
}

interface LotRow {
  patientId: string;
  patientName: string;
  patientDocument: string | null;
  toothNumber: string;
  professionalName: string;
  placedOn: string;
}

const IMPLANT = {
  toothNumber: '36',
  kind: 'IMPLANT',
  manufacturer: 'Straumann',
  system: 'BLT',
  reference: '021.5310',
  lot: LOT,
  diameterMm: 4.1,
  lengthMm: 10,
  sanitaryRegistration: 'REG-2020-0001',
  notes: 'Torque 35 Ncm',
};
const ABUTMENT = {
  toothNumber: '36',
  kind: 'ABUTMENT',
  manufacturer: 'Straumann',
  system: 'BLT',
  reference: 'RC-ABUT-4',
  lot: 'LOT-PILAR-7',
};

describe('Implantes — /patients/:id/implants, /implant-card, /implants (DX-191, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let dentist2: string;
  let reception: string;
  let assistant: string;
  let patient1: string;
  let patient2: string;
  let patientB: string;
  let implantId: string;
  let abutmentId: string;
  let today: string;

  const call = (
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  async function createPatient(
    clinic: Clinic,
    firstName: string,
    docNumber: string,
    docTypeLabel?: string,
  ): Promise<string> {
    const res = await call(clinic, clinic.adminToken, 'post', '/patients', {
      firstName,
      lastName: 'Implante',
      docType: 'NATIONAL_ID',
      docTypeLabel,
      docNumber,
      sex: 'F',
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'impl-a');
    b = await registerClinic(app, 'impl-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    const d2 = await raw.user.create({
      data: {
        email: 'dentist2@impl-a.test',
        passwordHash: (
          await raw.user.findUniqueOrThrow({ where: { id: d.userId } })
        ).passwordHash,
        fullName: 'Dr. Segundo',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: d2.id, role: ClinicRole.DENTIST },
    });
    dentist2 = await loginAs(app, a.host, 'dentist2@impl-a.test');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patient1 = await createPatient(a, 'Lucía', '52000001');
    patient2 = await createPatient(a, 'Mario', '52000002');
    patientB = await createPatient(b, 'Otra', '52000003');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('registro y ficha', () => {
    it('DENTIST registra un implante y un pilar en el 36; la ficha los muestra con REF y lote', async () => {
      const impl = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/implants`,
        IMPLANT,
      ).expect(201);
      const body = impl.body as ImplantBody & { placedOn: string };
      implantId = body.id;
      today = body.placedOn;
      expect(body).toMatchObject({
        toothNumber: '36',
        kind: 'IMPLANT',
        reference: '021.5310',
        lot: LOT,
        professionalId: dentist.userId,
        voidedAt: null,
      });
      abutmentId = (
        (
          await call(
            a,
            dentist.token,
            'post',
            `/patients/${patient1}/implants`,
            ABUTMENT,
          ).expect(201)
        ).body as ImplantBody
      ).id;

      const list = await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/implants`,
      ).expect(200);
      expect(
        (list.body as ImplantBody[])
          .map((i) => [i.kind, i.reference, i.lot])
          .sort(),
      ).toEqual([
        ['ABUTMENT', 'RC-ABUT-4', 'LOT-PILAR-7'],
        ['IMPLANT', '021.5310', LOT],
      ]);
    });

    it('400 en español si faltan fabricante, referencia y lote', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/implants`,
        {
          toothNumber: '36',
          kind: 'IMPLANT',
        },
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'No se puede registrar el implante: falta el fabricante; falta la referencia (REF); falta el lote.',
      );
    });

    it('400 con un diente FDI inválido', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/implants`,
        {
          ...IMPLANT,
          toothNumber: '39',
        },
      ).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /el diente «39» no es un código FDI válido/,
      );
    });

    it('no hay ruta para editar ni borrar un implante', async () => {
      for (const verb of ['patch', 'put', 'delete'] as const) {
        await request(app.getHttpServer())
          [verb](`/api/v1/implants/${implantId}`)
          .set('X-Tenant-Host', a.host)
          .set('Authorization', `Bearer ${a.adminToken}`)
          .send({ lot: 'OTRO' })
          .expect(404);
      }
    });
  });

  describe('tarjeta de implante', () => {
    it('contiene nombre y documento del paciente, el centro y ambos componentes; sin notas', async () => {
      const res = await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/implant-card?date=${today}`,
      ).expect(200);
      const card = res.body as CardBody;
      expect(card).toMatchObject({
        patientName: 'Lucía Implante',
        patientDocument: 'Documento nacional 52000001',
        clinicName: 'Clinica impl-a',
        placedOn: today,
        professionals: ['Miembro DENTIST'],
        deliveredAt: null,
      });
      expect(card.locations).toHaveLength(1);
      expect(card.items.map((i) => [i.kindLabel, i.reference, i.lot])).toEqual([
        ['Implante', '021.5310', LOT],
        ['Pilar', 'RC-ABUT-4', 'LOT-PILAR-7'],
      ]);
      expect(JSON.stringify(card)).not.toContain('Torque');
    });

    it('RECEPTION imprime: registra la entrega y deja PRINT en la auditoría', async () => {
      const res = await call(
        a,
        reception,
        'post',
        `/patients/${patient1}/implant-card/print`,
        {
          date: today,
        },
      ).expect(200);
      const delivered = (res.body as CardBody).deliveredAt;
      expect(delivered).not.toBeNull();
      // Reimprimir no mueve la fecha de entrega.
      const again = await call(
        a,
        reception,
        'post',
        `/patients/${patient1}/implant-card/print`,
        {
          date: today,
        },
      ).expect(200);
      expect((again.body as CardBody).deliveredAt).toBe(delivered);
      const prints = await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          action: 'PRINT',
          resourceType: 'PATIENT_IMPLANT',
          patientId: patient1,
        },
      });
      expect(prints).toBe(2);
    });

    it('400 sin día y 404 sin implantes ese día', async () => {
      await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/implant-card`,
      ).expect(400);
      await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/implant-card?date=2020-01-01`,
      ).expect(404);
    });
  });

  describe('anulación', () => {
    it('sin motivo, 400; otro odontólogo, 403; el autor anula y queda en audit_event; segunda vez, 409', async () => {
      await call(a, dentist.token, 'post', `/implants/${abutmentId}/void`, {
        reason: ' ',
      }).expect(400);
      await call(a, dentist2, 'post', `/implants/${abutmentId}/void`, {
        reason: 'Lote mal transcrito',
      }).expect(403);
      const res = await call(
        a,
        dentist.token,
        'post',
        `/implants/${abutmentId}/void`,
        {
          reason: 'Lote mal transcrito',
        },
      ).expect(200);
      expect(res.body as ImplantBody).toMatchObject({
        voidReason: 'Lote mal transcrito',
      });
      expect((res.body as ImplantBody).voidedAt).not.toBeNull();
      await call(a, a.adminToken, 'post', `/implants/${abutmentId}/void`, {
        reason: 'Otra vez',
      }).expect(409);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          action: 'VOID',
          resourceType: 'PATIENT_IMPLANT',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        resourceId: abutmentId,
        patientId: patient1,
        actorUserId: dentist.userId,
      });
    });

    it('la tarjeta marca el implante anulado', async () => {
      const res = await call(
        a,
        a.adminToken,
        'get',
        `/patients/${patient1}/implant-card?date=${today}`,
      ).expect(200);
      expect(
        (res.body as CardBody).items.map((i) => [i.kindLabel, i.voided]),
      ).toEqual([
        ['Implante', false],
        ['Pilar', true],
      ]);
    });
  });

  describe('roles', () => {
    it('RECEPTION y ASSISTANT no registran ni anulan (403 en español)', async () => {
      for (const token of [reception, assistant]) {
        const res = await call(
          a,
          token,
          'post',
          `/patients/${patient1}/implants`,
          IMPLANT,
        ).expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Solo el odontólogo o la administración registran y anulan implantes.',
        );
        await call(a, token, 'post', `/implants/${implantId}/void`, {
          reason: 'No debería poder',
        }).expect(403);
      }
    });

    it('la búsqueda por lote y el CSV son solo ADMIN', async () => {
      for (const token of [reception, assistant, dentist.token]) {
        await call(a, token, 'get', `/implants/search?lot=${LOT}`).expect(403);
        await call(a, token, 'get', `/implants/search.csv?lot=${LOT}`).expect(
          403,
        );
      }
    });
  });

  describe('búsqueda por lote y aislamiento entre clínicas', () => {
    beforeAll(async () => {
      // Segundo paciente de A con el MISMO lote (otra dentista) y un paciente
      // de B con el mismo lote: B no debe salir en la búsqueda de A.
      await call(a, dentist2, 'post', `/patients/${patient2}/implants`, {
        ...IMPLANT,
        toothNumber: '46',
        lot: LOT.toLowerCase(),
      }).expect(201);
      await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patientB}/implants`,
        IMPLANT,
      ).expect(201);
    });

    it('devuelve los 2 pacientes de la clínica que lo recibieron y ninguno de otra', async () => {
      const res = await call(
        a,
        a.adminToken,
        'get',
        `/implants/search?lot=${LOT}`,
      ).expect(200);
      const rows = res.body as LotRow[];
      expect(rows.map((r) => r.patientId).sort()).toEqual(
        [patient1, patient2].sort(),
      );
      expect(rows).not.toContainEqual(
        expect.objectContaining({ patientId: patientB }),
      );
      expect(rows.find((r) => r.patientId === patient2)).toMatchObject({
        toothNumber: '46',
        professionalName: 'Dr. Segundo',
      });
      const bRows = await call(
        b,
        b.adminToken,
        'get',
        `/implants/search?lot=${LOT}`,
      ).expect(200);
      expect((bRows.body as LotRow[]).map((r) => r.patientId)).toEqual([
        patientB,
      ]);
    });

    it('sin lote ni REF, 400', async () => {
      await call(a, a.adminToken, 'get', '/implants/search').expect(400);
    });

    it('el CSV lleva las 2 filas y la auditoría el lote buscado y el nº de filas', async () => {
      const res = await call(
        a,
        a.adminToken,
        'get',
        `/implants/search.csv?lot=${LOT}`,
      ).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text.trim().split('\r\n')).toHaveLength(3);
      expect(res.text).not.toContain('Otra Implante');
      const exportEvent = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          action: 'EXPORT',
          resourceType: 'PATIENT_IMPLANT',
        },
      });
      expect(exportEvent.metadata).toMatchObject({
        reason: 'IMPLANT_LOT_SEARCH',
        search: { lot: LOT, rows: 2 },
      });
      const viewEvent = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          action: 'VIEW',
          resourceType: 'PATIENT_IMPLANT',
          patientId: null,
        },
      });
      expect(viewEvent.metadata).toMatchObject({
        search: { lot: LOT, rows: 2 },
      });
    });

    it('el autocompletar trae los fabricantes y sistemas de la clínica', async () => {
      const res = await call(
        a,
        dentist.token,
        'get',
        '/implants/catalog',
      ).expect(200);
      expect(res.body).toEqual([
        { manufacturer: 'Straumann', systems: ['BLT'] },
      ]);
    });

    // ISOLATION_COVERS: GET /patients/:patientId/implants
    // ISOLATION_COVERS: POST /patients/:patientId/implants
    // ISOLATION_COVERS: GET /patients/:patientId/implant-card
    // ISOLATION_COVERS: POST /patients/:patientId/implant-card/print
    // ISOLATION_COVERS: POST /implants/:id/void
    it('B no ve ni toca los implantes de A (404)', async () => {
      await call(
        b,
        b.adminToken,
        'get',
        `/patients/${patient1}/implants`,
      ).expect(404);
      await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patient1}/implants`,
        IMPLANT,
      ).expect(404);
      await call(
        b,
        b.adminToken,
        'get',
        `/patients/${patient1}/implant-card?date=${today}`,
      ).expect(404);
      await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patient1}/implant-card/print`,
        {
          date: today,
        },
      ).expect(404);
      await call(b, b.adminToken, 'post', `/implants/${implantId}/void`, {
        reason: 'Intento ajeno',
      }).expect(404);
      const still = await raw.patientImplant.findUniqueOrThrow({
        where: { id: implantId },
      });
      expect(still.voidedAt).toBeNull();
    });
  });
  describe('revisión: sede activa e ítem del plan', () => {
    async function planItemOf(
      clinic: Clinic,
      patientId: string,
      code: string,
    ): Promise<string> {
      const catalog = await call(
        clinic,
        clinic.adminToken,
        'post',
        '/catalog/items',
        {
          code,
          kind: 'PROCEDURE',
          labelEs: 'Implante',
          color: '#2A2B3C',
          defaultPrice: 1,
        },
      ).expect(201);
      const plan = await call(
        clinic,
        clinic.adminToken,
        'post',
        `/patients/${patientId}/treatment-plans`,
        { currency: 'COP' },
      ).expect(201);
      const item = await call(
        clinic,
        clinic.adminToken,
        'post',
        `/treatment-plans/${(plan.body as { id: string }).id}/items`,
        {
          toothNumber: '36',
          catalogItemId: (catalog.body as { id: string }).id,
          price: 1,
        },
      ).expect(201);
      return (item.body as { id: string }).id;
    }

    it('la búsqueda por lote abarca toda la clínica aunque llegue una sede activa', async () => {
      const norte = (
        (
          await call(
            a,
            a.adminToken,
            'post',
            '/locations',
            locationBody(REGIONAL_BOGOTA_FIXTURE, {
              name: 'Sede Norte',
              address: 'Cra 15',
            }),
          ).expect(201)
        ).body as { id: string }
      ).id;
      await call(a, dentist.token, 'post', `/patients/${patient1}/implants`, {
        ...IMPLANT,
        lot: 'LOT-SEDES-01',
      }).expect(201);
      await call(a, dentist2, 'post', `/patients/${patient2}/implants`, {
        ...IMPLANT,
        toothNumber: '46',
        lot: 'LOT-SEDES-01',
      })
        .set('X-Location-Id', norte)
        .expect(201);

      const res = await call(
        a,
        a.adminToken,
        'get',
        '/implants/search?lot=LOT-SEDES-01',
      )
        .set('X-Location-Id', norte)
        .expect(200);
      const rows = res.body as LotRow[];
      expect(rows.map((r) => r.patientId).sort()).toEqual(
        [patient1, patient2].sort(),
      );
      const csv = await call(
        a,
        a.adminToken,
        'get',
        '/implants/search.csv?lot=LOT-SEDES-01',
      )
        .set('X-Location-Id', norte)
        .expect(200);
      expect(csv.text.trim().split('\r\n')).toHaveLength(3);
    });

    it('el ítem del plan tiene que ser de un plan del MISMO paciente y clínica', async () => {
      const own = await planItemOf(a, patient1, 'IMPL-REV-A1');
      const otherPatient = await planItemOf(a, patient2, 'IMPL-REV-A2');
      const otherClinic = await planItemOf(b, patientB, 'IMPL-REV-B1');
      for (const itemId of [otherPatient, otherClinic]) {
        const res = await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/implants`,
          { ...IMPLANT, lot: 'LOT-PLAN-01', treatmentPlanItemId: itemId },
        ).expect(400);
        expect((res.body as { message: string }).message).toMatch(
          /ítem del plan/,
        );
      }
      const ok = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/implants`,
        { ...IMPLANT, lot: 'LOT-PLAN-01', treatmentPlanItemId: own },
      ).expect(201);
      expect(ok.body).toMatchObject({ treatmentPlanItemId: own });
    });
  });

  describe('nombre del documento (DX-327)', () => {
    const lotSearch = async (lot: string) =>
      (
        await call(
          a,
          a.adminToken,
          'get',
          `/implants/search?lot=${lot}`,
        ).expect(200)
      ).body as LotRow[];

    it('the implant card and the lot search print the free label', async () => {
      const patient = await createPatient(a, 'Lia', 'IMPL-40', 'ID local');
      const placed = (
        await call(a, dentist.token, 'post', `/patients/${patient}/implants`, {
          ...IMPLANT,
          lot: 'LOT-DX327-01',
        }).expect(201)
      ).body as { placedOn: string };
      const card = (
        await call(
          a,
          reception,
          'get',
          `/patients/${patient}/implant-card?date=${placed.placedOn}`,
        ).expect(200)
      ).body as CardBody;
      expect(card.patientDocument).toBe('ID local IMPL-40');
      expect(await lotSearch('LOT-DX327-01')).toEqual([
        expect.objectContaining({
          patientId: patient,
          patientDocument: 'ID local IMPL-40',
        }),
      ]);
    });

    it('legacy TI patient seeded by SQL prints «Documento nacional …» in the lot search', async () => {
      const [{ id }] = await raw.$queryRaw<{ id: string }[]>`
        INSERT INTO "patients" ("id","tenantId","firstName","lastName","docType","docNumber","updatedAt")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, 'Anterior', 'Implante', 'TI', 'IMPL-41', now())
        RETURNING "id"::text AS "id"`;
      await call(a, dentist.token, 'post', `/patients/${id}/implants`, {
        ...IMPLANT,
        lot: 'LOT-DX327-02',
      }).expect(201);
      expect(await lotSearch('LOT-DX327-02')).toEqual([
        expect.objectContaining({
          patientId: id,
          patientDocument: 'Documento nacional IMPL-41',
        }),
      ]);

      // En vivo: el nombre local de hoy de la clínica.
      await raw.tenant.update({
        where: { id: a.tenantId },
        data: { docTypeNameNationalId: 'Documento A' },
      });
      try {
        expect((await lotSearch('LOT-DX327-02'))[0].patientDocument).toBe(
          'Documento A IMPL-41',
        );
      } finally {
        await raw.tenant.update({
          where: { id: a.tenantId },
          data: { docTypeNameNationalId: null },
        });
      }
    });
  });
});
