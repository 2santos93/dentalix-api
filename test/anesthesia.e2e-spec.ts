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
import {
  locationBody,
  REGIONAL_BOGOTA_FIXTURE,
} from './support/location-fixtures';

// DX-307 · anestesia local en la evolución, de punta a punta con Postgres:
// 409 sin motivo y 201 con motivo + auditoría (criterio de los 3 carpules de
// articaína a 20 kg), suma de fracciones, menor sin peso, alergia, permisos
// por rol, aislamiento por clínica y por sede (DX-089/DX-207) e inmutabilidad
// (405 en la API y trigger en la BD). DIRECT_URL solo para sembrar y leer.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OVERRIDE = 'Exodoncia infantil compleja, valorado con la madre';

interface Product {
  id: string;
  name: string;
  sampleCode: string | null;
  mlPerCarpule: number;
}

interface Summary {
  totalMg: number;
  percent: number | null;
  level: string;
  alerts: { code: string; severity: string; message: string }[];
  byAnesthetic: { mg: number; maxMg: number | null; percent: number | null }[];
}

describe('Anestesia local en la evolución (DX-307, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentistA: { token: string; userId: string };
  let assistantA: string;
  let receptionA: string;
  let restrictedDentistA: string;
  let catalogA: Product[];
  let catalogB: Product[];
  let child: string;
  let adult: string;
  let allergic: string;
  let childEntry: string;
  let adultEntry: string;
  let allergicEntry: string;
  let patientB: string;
  let entryB: string;

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
  const anesthesia = (patientId: string, entryId: string) =>
    `/patients/${patientId}/clinical-entries/${entryId}/anesthesia`;
  const byCode = (list: Product[], code: string) =>
    list.find((p) => p.sampleCode === code) as Product;

  async function createPatient(
    clinic: Clinic,
    name: string,
    birthDate: string,
    history?: Prisma.MedicalHistoryVersionUncheckedCreateInput['vitalSigns'],
    allergies?: Prisma.InputJsonValue,
  ): Promise<string> {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: name,
        lastName: 'Prueba',
        birthDate: new Date(birthDate),
      },
    });
    if (history !== undefined) {
      await raw.medicalHistoryVersion.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient.id,
          version: 1,
          vitalSigns: history,
          allergies,
          safetyFlags: {},
          hasCriticalAlert: false,
          createdById: clinic.adminUserId,
        },
      });
    }
    return patient.id;
  }

  async function createEntry(
    clinic: Clinic,
    patientId: string,
    token: string,
  ): Promise<string> {
    const res = await call(
      clinic,
      'post',
      `/patients/${patientId}/clinical-entries`,
      token,
    )
      .send({ notes: 'Exodoncia' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx307-a');
    b = await registerClinic(app, 'dx307-b');
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

    // Un segundo odontólogo restringido a otra sede (DX-089).
    const north = (
      await call(a, 'post', '/locations', a.adminToken)
        .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
        .expect(201)
    ).body as { id: string };
    const restrictedUser = await raw.user.create({
      data: {
        email: 'norte@dx307-a.test',
        passwordHash: (
          await raw.user.findUniqueOrThrow({ where: { id: dentist.userId } })
        ).passwordHash,
        fullName: 'Dentista Norte',
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: restrictedUser.id,
        role: 'DENTIST',
      },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: membership.id,
        locationId: north.id,
      },
    });
    restrictedDentistA = await loginAs(app, a.host, 'norte@dx307-a.test');

    catalogA = (
      await call(a, 'post', '/anesthetics/samples', a.adminToken).expect(201)
    ).body as Product[];
    catalogB = (
      await call(b, 'post', '/anesthetics/samples', b.adminToken).expect(201)
    ).body as Product[];

    child = await createPatient(a, 'Niña', '2018-05-10', { peso: 20 });
    adult = await createPatient(a, 'Adulto', '1980-01-01', {});
    allergic = await createPatient(a, 'Alérgica', '1990-01-01', { peso: 60 }, [
      { alergeno: 'Lidocaína', reaccion: 'urticaria' },
    ]);
    childEntry = await createEntry(a, child, dentistA.token);
    adultEntry = await createEntry(a, adult, dentistA.token);
    allergicEntry = await createEntry(a, allergic, dentistA.token);
    patientB = await createPatient(b, 'Bea', '1990-01-01', { peso: 70 });
    entryB = await createEntry(b, patientB, b.adminToken);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('catálogo', () => {
    it('los sugeridos llegan con los valores de referencia y no se duplican', async () => {
      expect(catalogA).toHaveLength(5);
      expect(byCode(catalogA, 'ARTICAINE_4_EPI').mlPerCarpule).toBe(1.7);
      const again = await call(
        a,
        'post',
        '/anesthetics/samples',
        a.adminToken,
      ).expect(201);
      expect(again.body).toEqual([]);
      const list = await call(a, 'get', '/anesthetics', assistantA).expect(200);
      expect((list.body as Product[]).map((p) => p.id).sort()).toEqual(
        catalogA.map((p) => p.id).sort(),
      );
    });

    it('solo ADMIN lo edita; recepción ni lo lee', async () => {
      await call(a, 'post', '/anesthetics/samples', dentistA.token).expect(403);
      await call(a, 'patch', `/anesthetics/${catalogA[0].id}`, dentistA.token)
        .send({ maxMgPerKg: 4.4 })
        .expect(403);
      await call(a, 'get', '/anesthetics', receptionA).expect(403);
    });

    it('un anestésico de otra clínica es 404', async () => {
      await call(a, 'patch', `/anesthetics/${catalogB[0].id}`, a.adminToken)
        .send({ maxMgPerKg: 4.4 })
        .expect(404);
    });
  });

  describe('criterio: 3 carpules de articaína 4 % (1,7 ml) a 20 kg', () => {
    const body = () => ({
      anestheticId: byCode(catalogA, 'ARTICAINE_4_EPI').id,
      carpules: 3,
      technique: 'NERVE_BLOCK',
      site: '85',
      lot: 'ART-2026-11',
    });

    it('la previsualización da 204 mg de 140 mg (146 %) sin guardar', async () => {
      const res = await call(
        a,
        'post',
        `${anesthesia(child, childEntry)}/check`,
        dentistA.token,
      )
        .send({ anestheticId: body().anestheticId, carpules: 3 })
        .expect(200);
      const check = res.body as { summary: Summary; ageYears: number };
      expect(check.summary.totalMg).toBe(204);
      expect(check.summary.byAnesthetic[0]).toEqual(
        expect.objectContaining({ mg: 204, maxMg: 140, percent: 146 }),
      );
      expect(check.summary.level).toBe('EXCEEDED');
      expect(await raw.anesthesiaAdministration.count()).toBe(0);
    });

    it('sin overrideReason → 409 con el resumen y no guarda', async () => {
      const res = await call(
        a,
        'post',
        anesthesia(child, childEntry),
        dentistA.token,
      )
        .send(body())
        .expect(409);
      const conflict = res.body as { message: string; summary: Summary };
      expect(conflict.message).toContain('204 mg de 140 mg (146 %)');
      expect(conflict.summary.percent).toBe(146);
      expect(await raw.anesthesiaAdministration.count()).toBe(0);
    });

    it('con motivo → 201, sella el motivo y la copia del catálogo, y queda en el audit log sin textos', async () => {
      const res = await call(
        a,
        'post',
        anesthesia(child, childEntry),
        dentistA.token,
      )
        .send({ ...body(), overrideReason: OVERRIDE })
        .expect(201);
      const saved = res.body as {
        id: string;
        doseMg: number;
        cumulativePercent: number;
        overrideReason: string;
        authorId: string;
        weightKg: number;
        weightSource: string;
        mlPerCarpule: number;
        summary: Summary;
      };
      expect(saved).toEqual(
        expect.objectContaining({
          doseMg: 204,
          cumulativePercent: 146,
          overrideReason: OVERRIDE,
          authorId: dentistA.userId,
          weightKg: 20,
          weightSource: 'ANAMNESIS',
          mlPerCarpule: 1.7,
        }),
      );
      const events = await raw.auditEvent.findMany({
        where: {
          resourceType: 'ANESTHESIA_ADMINISTRATION',
          action: 'CREATE',
          resourceId: saved.id,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: a.tenantId,
        actorUserId: dentistA.userId,
        patientId: child,
      });
      expect(
        (events[0].metadata as { anesthesiaSafety: unknown }).anesthesiaSafety,
      ).toEqual({
        rulesVersion: 'ANESTHESIA_DOSE_V1',
        blocking: ['DOSE_OVER_MAX'],
        info: [],
        overridden: true,
      });
      expect(JSON.stringify(events[0])).not.toContain(OVERRIDE);
      expect(JSON.stringify(events[0])).not.toContain('204');
    });

    it('la evolución lista el registro y el acumulado; la ficha lo ve', async () => {
      const res = await call(
        a,
        'get',
        anesthesia(child, childEntry),
        assistantA,
      ).expect(200);
      const entry = res.body as { records: { id: string }[]; summary: Summary };
      expect(entry.records).toHaveLength(1);
      expect(entry.summary.percent).toBe(146);
      const all = await call(
        a,
        'get',
        `/patients/${child}/anesthesia`,
        dentistA.token,
      ).expect(200);
      expect(all.body).toHaveLength(1);
    });
  });

  it('dos anestésicos: el % es la suma de fracciones (lidocaína 51 % + articaína 49 % → 409)', async () => {
    const entry = await createEntry(a, child, dentistA.token);
    await call(a, 'post', anesthesia(child, entry), dentistA.token)
      .send({
        anestheticId: byCode(catalogA, 'LIDOCAINE_2_EPI').id,
        carpules: 2,
        technique: 'INFILTRATION',
      })
      .expect(201);
    const res = await call(a, 'post', anesthesia(child, entry), dentistA.token)
      .send({
        anestheticId: byCode(catalogA, 'ARTICAINE_4_EPI').id,
        carpules: 1,
        technique: 'INFILTRATION',
      })
      .expect(409);
    const summary = (res.body as { summary: Summary }).summary;
    expect(summary.byAnesthetic.map((x) => x.percent)).toEqual([51, 49]);
    expect(summary.percent).toBe(100);
  });

  it('adulto sin peso: se guarda y dice «Dosis máxima no calculada: falta el peso»', async () => {
    const res = await call(
      a,
      'post',
      anesthesia(adult, adultEntry),
      dentistA.token,
    )
      .send({
        anestheticId: byCode(catalogA, 'LIDOCAINE_2_EPI').id,
        carpules: 2,
        technique: 'NERVE_BLOCK',
      })
      .expect(201);
    const saved = res.body as { cumulativePercent: null; summary: Summary };
    expect(saved.cumulativePercent).toBeNull();
    expect(saved.summary.alerts.map((x) => x.message)).toContain(
      'Dosis máxima no calculada: falta el peso.',
    );
  });

  it('menor de 12 años sin peso: 400 hasta anotar el peso', async () => {
    const kid = await createPatient(a, 'Niño', '2019-02-02');
    const entry = await createEntry(a, kid, dentistA.token);
    const send = (extra: object) =>
      call(a, 'post', anesthesia(kid, entry), dentistA.token).send({
        anestheticId: byCode(catalogA, 'LIDOCAINE_2_EPI').id,
        carpules: 1,
        technique: 'INFILTRATION',
        ...extra,
      });
    const res = await send({}).expect(400);
    expect((res.body as { message: string }).message).toContain(
      'Registra el peso',
    );
    const ok = await send({ weightKg: 18 }).expect(201);
    expect((ok.body as { weightSource: string }).weightSource).toBe('ENTERED');
  });

  it('alergia a la lidocaína + articaína (amida): 409 y con motivo queda auditado', async () => {
    const body = {
      anestheticId: byCode(catalogA, 'ARTICAINE_4_EPI').id,
      carpules: 1,
      technique: 'INFILTRATION',
    };
    const res = await call(
      a,
      'post',
      anesthesia(allergic, allergicEntry),
      dentistA.token,
    )
      .send(body)
      .expect(409);
    expect((res.body as { message: string }).message).toContain('Alergia');
    const ok = await call(
      a,
      'post',
      anesthesia(allergic, allergicEntry),
      dentistA.token,
    )
      .send({ ...body, overrideReason: 'Prueba cutánea negativa a articaína' })
      .expect(201);
    const events = await raw.auditEvent.findMany({
      where: { resourceId: (ok.body as { id: string }).id },
    });
    expect(
      (events[0].metadata as { anesthesiaSafety: { blocking: string[] } })
        .anesthesiaSafety.blocking,
    ).toEqual(['ALLERGY_ANESTHETIC']);
  });

  describe('permisos y aislamiento', () => {
    const body = () => ({
      anestheticId: byCode(catalogA, 'LIDOCAINE_2_EPI').id,
      carpules: 1,
      technique: 'INFILTRATION',
    });

    it('la asistente la ve pero no la registra; recepción, nada', async () => {
      await call(a, 'post', anesthesia(adult, adultEntry), assistantA)
        .send(body())
        .expect(403);
      await call(a, 'get', anesthesia(adult, adultEntry), receptionA).expect(
        403,
      );
      await call(a, 'get', `/patients/${adult}/anesthesia`, receptionA).expect(
        403,
      );
    });

    it('un anestésico de otra clínica no se acepta (404)', async () => {
      await call(a, 'post', anesthesia(adult, adultEntry), dentistA.token)
        .send({
          ...body(),
          anestheticId: byCode(catalogB, 'LIDOCAINE_2_EPI').id,
        })
        .expect(404);
      await call(
        a,
        'post',
        `${anesthesia(adult, adultEntry)}/check`,
        dentistA.token,
      )
        .send({
          anestheticId: byCode(catalogB, 'LIDOCAINE_2_EPI').id,
          carpules: 1,
        })
        .expect(404);
    });

    it('paciente o evolución de otra clínica, o evolución de otro paciente: 404', async () => {
      await call(a, 'get', anesthesia(patientB, entryB), dentistA.token).expect(
        404,
      );
      await call(a, 'post', anesthesia(adult, entryB), dentistA.token)
        .send(body())
        .expect(404);
      await call(a, 'post', anesthesia(adult, childEntry), dentistA.token)
        .send(body())
        .expect(404);
      await call(
        b,
        'get',
        `/patients/${child}/anesthesia`,
        b.adminToken,
      ).expect(404);
    });

    it('un odontólogo restringido a otra sede: 403 en la evolución y no la ve en la ficha', async () => {
      await call(
        a,
        'get',
        anesthesia(child, childEntry),
        restrictedDentistA,
      ).expect(403);
      await call(a, 'post', anesthesia(child, childEntry), restrictedDentistA)
        .send(body())
        .expect(403);
      const all = await call(
        a,
        'get',
        `/patients/${child}/anesthesia`,
        restrictedDentistA,
      ).expect(200);
      expect(all.body).toEqual([]);
    });

    it('la RLS: con el tenant de B, la app no ve las filas de A', async () => {
      const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const seen = await appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
          return {
            records: await tx.anesthesiaAdministration.count(),
            products: await tx.anestheticProduct.count({
              where: { tenantId: a.tenantId },
            }),
          };
        });
        expect(seen).toEqual({ records: 0, products: 0 });
      } finally {
        await appRole.$disconnect();
      }
    });
  });

  describe('inmutabilidad', () => {
    it('PATCH/PUT/DELETE responden 405 remitiendo a la adenda', async () => {
      const row = await raw.anesthesiaAdministration.findFirstOrThrow({
        where: { tenantId: a.tenantId },
      });
      for (const verb of ['patch', 'put', 'delete'] as const) {
        const res = await call(
          a,
          verb,
          `${anesthesia(row.patientId, row.clinicalEntryId)}/${row.id}`,
          dentistA.token,
        ).expect(405);
        expect((res.body as { message: string }).message).toContain('adenda');
      }
    });

    it('la BD rechaza UPDATE (trigger) y DELETE (sin permiso y trigger) del rol de la app', async () => {
      const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const row = await raw.anesthesiaAdministration.findFirstOrThrow({
          where: { tenantId: a.tenantId },
        });
        const asApp = (sql: Prisma.Sql) =>
          appRole.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            return tx.$executeRaw(sql);
          });
        await expect(
          asApp(
            Prisma.sql`UPDATE "anesthesia_administrations" SET "carpules" = 1 WHERE "id" = ${row.id}::uuid`,
          ),
        ).rejects.toThrow(/inalterable/);
        await expect(
          asApp(
            Prisma.sql`DELETE FROM "anesthesia_administrations" WHERE "id" = ${row.id}::uuid`,
          ),
        ).rejects.toThrow(/inalterable|permission denied/);
      } finally {
        await appRole.$disconnect();
      }
    });

    it('editar el catálogo no cambia lo ya registrado', async () => {
      const lido = byCode(catalogA, 'LIDOCAINE_2_EPI');
      await call(a, 'patch', `/anesthetics/${lido.id}`, a.adminToken)
        .send({ maxMgPerKg: 4.4, maxAbsoluteMg: 300 })
        .expect(200);
      const rows = await raw.anesthesiaAdministration.findMany({
        where: { anestheticId: lido.id },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => Number(r.maxMgPerKg) === 7)).toBe(true);
    });
  });
});
