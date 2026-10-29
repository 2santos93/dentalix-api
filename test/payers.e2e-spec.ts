import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PAYER_TYPES } from '../src/modules/payers/domain/payer-type';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  locationData,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  type RegionalFixture,
} from './support/location-fixtures';

// DX-153 en HTTP real: catálogo de pagadores (alta ADMIN y recepción, edición
// y retiro solo ADMIN), duplicado sin mayúsculas ni tildes, desactivar frente
// a retirar, y aislamiento entre clínicas. DX-326: tipo genérico y sin país.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface PayerBody {
  id: string;
  name: string;
  type: string;
  active: boolean;
}

describe('Pagadores (e2e, DX-153)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPayer(
    body: Record<string, unknown>,
    token = tokens.ADMIN,
  ): Promise<PayerBody> {
    const res = await as(api().post('/api/v1/payers'), token)
      .send(body)
      .expect(201);
    return res.body as PayerBody;
  }

  /** Alta de paciente por API; devuelve su id. */
  async function newPatient(
    docNumber: string,
    token = tokens.ADMIN,
    host = clinic.host,
  ): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), token, host)
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'CC',
        docNumber,
        sex: 'F',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Pagador por SQL crudo: lo que una réplica anterior dejó guardado. */
  async function insertPayer(
    name: string,
    type: string,
    country: string | null,
  ): Promise<string> {
    const rows = await raw.$queryRaw<{ id: string }[]>`
      INSERT INTO "payers" ("id", "tenantId", "name", "type", "country", "updatedAt")
      VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${name},
              ${type}::"PayerType", ${country}::"ClinicCountry", now())
      RETURNING "id"`;
    return rows[0].id;
  }

  async function storedCountry(id: string): Promise<string | null> {
    const rows = await raw.$queryRaw<{ country: string | null }[]>`
      SELECT "country"::text AS country FROM "payers" WHERE id = ${id}::uuid`;
    return rows[0].country;
  }

  async function names(query = '', token = tokens.ADMIN, c = clinic) {
    const res = await as(
      api().get(`/api/v1/payers${query}`),
      token,
      c.host,
    ).expect(200);
    return (res.body as PayerBody[]).map((p) => p.name);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx153-payers');
    other = await registerClinic(app, 'dx153-payers-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await raw.$disconnect();
    await app.close();
  });

  it('ADMIN crea un pagador: la respuesta lleva el tipo genérico y ninguna clave country', async () => {
    const payer = await createPayer({
      name: '  Sistema   Público Central ',
      type: 'PUBLIC_SYSTEM',
    });
    expect(payer).toMatchObject({
      name: 'Sistema Público Central',
      type: 'PUBLIC_SYSTEM',
      active: true,
    });
    expect(payer).not.toHaveProperty('country');
  });

  it('recepción crea (201)', async () => {
    const payer = await createPayer(
      { name: 'Empresa Mostrador', type: 'EMPLOYER' },
      tokens.RECEPTION,
    );
    expect(payer.type).toBe('EMPLOYER');
    expect(payer).not.toHaveProperty('country');
  });

  it('el dentista no crea (403)', async () => {
    await as(api().post('/api/v1/payers'), tokens.DENTIST)
      .send({ name: 'Nada', type: 'OTHER' })
      .expect(403);
  });

  it('un nombre que solo cambia en mayúsculas o tildes da 409 en español', async () => {
    await createPayer({ name: 'Seguros Bolívar', type: 'OTHER' });
    const res = await as(api().post('/api/v1/payers'), tokens.ADMIN)
      .send({ name: ' SEGUROS  bolivar', type: 'OTHER' })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Ya existe un pagador con ese nombre.',
    );
  });

  it('un tipo desconocido da 400 con la lista de los cinco genéricos', async () => {
    const res = await as(api().post('/api/v1/payers'), tokens.ADMIN)
      .send({ name: 'Tipo raro', type: 'XX' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'El tipo de pagador debe ser uno de: INSURER, PREPAID_PLAN, PUBLIC_SYSTEM, EMPLOYER, OTHER.',
    );
  });

  it('un cuerpo vacío da 400', async () => {
    await as(api().post('/api/v1/payers'), tokens.ADMIN).send({}).expect(400);
  });

  it('el listado va por nombre y lo ven los cuatro roles', async () => {
    for (const token of Object.values(tokens)) {
      expect(await names('', token)).toEqual([
        'Empresa Mostrador',
        'Seguros Bolívar',
        'Sistema Público Central',
      ]);
    }
  });

  it('desactivar lo oculta del listado y includeInactive lo muestra', async () => {
    const payer = await createPayer({
      name: 'Plan Sur Z',
      type: 'PREPAID_PLAN',
    });
    const res = await as(
      api().patch(`/api/v1/payers/${payer.id}`),
      tokens.ADMIN,
    )
      .send({ active: false })
      .expect(200);
    expect((res.body as PayerBody).active).toBe(false);
    expect(await names()).not.toContain('Plan Sur Z');
    expect(await names('?includeInactive=true')).toContain('Plan Sur Z');
  });

  it('legacy web PATCH with country null is 200 and the response has no country', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326. El PATCH
    // exacto de la web anterior: nombre, tipo antiguo y country null.
    const empresa = await createPayer({
      name: 'Empresa Beta',
      type: 'EMPLOYER',
    });
    const ok = await as(
      api().patch(`/api/v1/payers/${empresa.id}`),
      tokens.ADMIN,
    )
      .send({ name: 'Empresa Beta', type: 'EMPRESA', country: null })
      .expect(200);
    expect((ok.body as PayerBody).type).toBe('EMPLOYER');
    expect(ok.body).not.toHaveProperty('country');
  });

  it('legacy type codes in the body are accepted as their generic type during the rollout', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
    const LEGACY = [
      ['MUTUA_ES', 'INSURER'],
      ['PREPAGADA_CO', 'PREPAID_PLAN'],
      ['EPS_CO', 'PUBLIC_SYSTEM'],
      ['EMPRESA', 'EMPLOYER'],
      ['OTRO', 'OTHER'],
    ] as const;
    for (const [code, type] of LEGACY) {
      const payer = await createPayer({
        name: `Legado ${code}`,
        type: code,
        country: 'CO',
      });
      expect(payer.type).toBe(type);
      const patched = await as(
        api().patch(`/api/v1/payers/${payer.id}`),
        tokens.ADMIN,
      )
        .send({ type: code, country: null })
        .expect(200);
      expect((patched.body as PayerBody).type).toBe(type);
      await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
        204,
      );
    }
  });

  it('legacy codes are stored for new payers during phase 1', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
    // Fase 1 (R5): la BD guarda el código anterior de cada tipo genérico, al
    // crear y al editar, y nunca un código nuevo; `country` queda NULL.
    const LEGACY = {
      INSURER: 'MUTUA_ES',
      PREPAID_PLAN: 'PREPAGADA_CO',
      PUBLIC_SYSTEM: 'EPS_CO',
      EMPLOYER: 'EMPRESA',
      OTHER: 'OTRO',
    } as const;
    const stored = async (id: string) =>
      (
        await raw.$queryRaw<{ type: string; country: string | null }[]>`
          SELECT "type"::text AS type, "country"::text AS country
          FROM "payers" WHERE id = ${id}::uuid`
      )[0];
    const types = Object.keys(LEGACY) as (keyof typeof LEGACY)[];
    for (const [i, type] of types.entries()) {
      const payer = await createPayer({ name: `Fase uno ${type}`, type });
      expect(payer.type).toBe(type);
      expect(await stored(payer.id)).toEqual({
        type: LEGACY[type],
        country: null,
      });
      // Editar hacia el siguiente tipo también guarda su código anterior.
      const next = types[(i + 1) % types.length];
      const res = await as(
        api().patch(`/api/v1/payers/${payer.id}`),
        tokens.ADMIN,
      )
        .send({ type: next })
        .expect(200);
      expect((res.body as PayerBody).type).toBe(next);
      expect((await stored(payer.id)).type).toBe(LEGACY[next]);
      await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
        204,
      );
    }
    const generic = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "payers"
      WHERE "type"::text IN ('INSURER', 'PREPAID_PLAN', 'PUBLIC_SYSTEM', 'EMPLOYER', 'OTHER')`;
    expect(generic[0].n).toBe(0);
  });

  it('el PATCH con name, type o active en null da 400, nunca 500', async () => {
    const payer = await createPayer({ name: 'Null no', type: 'OTHER' });
    for (const body of [{ name: null }, { type: null }, { active: null }]) {
      await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
        .send(body)
        .expect(400);
    }
  });

  it('tras retirar un pagador, otro con el mismo nombre se crea (201)', async () => {
    const first = await createPayer({
      name: 'Nombre reutilizable',
      type: 'OTHER',
    });
    await as(api().delete(`/api/v1/payers/${first.id}`), tokens.ADMIN).expect(
      204,
    );
    const second = await createPayer({
      name: 'nombre REUTILIZABLE',
      type: 'OTHER',
    });
    expect(second.id).not.toBe(first.id);
  });

  it('un nombre que coincide con un pagador DESACTIVADO da un 409 que lo dice', async () => {
    const off = await createPayer({ name: 'Colsanitas Off', type: 'OTHER' });
    await as(api().patch(`/api/v1/payers/${off.id}`), tokens.ADMIN)
      .send({ active: false })
      .expect(200);
    const res = await as(api().post('/api/v1/payers'), tokens.RECEPTION)
      .send({ name: 'colsanitas off', type: 'OTHER' })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Ya existe un pagador con ese nombre, pero está desactivado; pídele a administración que lo reactive.',
    );
    const other = await createPayer({ name: 'Colsanitas Otro', type: 'OTHER' });
    const renamed = await as(
      api().patch(`/api/v1/payers/${other.id}`),
      tokens.ADMIN,
    )
      .send({ name: 'COLSANITAS OFF' })
      .expect(409);
    expect((renamed.body as { message: string }).message).toContain(
      'está desactivado',
    );
  });

  it('renombrar hacia el nombre de otro da 409; recepción no edita', async () => {
    const payer = await createPayer({ name: 'Otro Pagador', type: 'OTHER' });
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
      .send({ name: 'sistema publico central' })
      .expect(409);
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.RECEPTION)
      .send({ name: 'X Pagador' })
      .expect(403);
  });

  it('retirar sin coberturas da 204 y deja de listarse', async () => {
    const payer = await createPayer({ name: 'Para retirar', type: 'OTHER' });
    await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
      204,
    );
    expect(await names('?includeInactive=true')).not.toContain('Para retirar');
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
      .send({ active: true })
      .expect(404);
  });

  it('retirar con una cobertura viva da 409 y el pagador sigue', async () => {
    const payer = await createPayer({ name: 'Con cobertura', type: 'OTHER' });
    const patient = await as(api().post('/api/v1/patients'), tokens.ADMIN)
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'CC',
        docNumber: '1010101010',
        sex: 'F',
      })
      .expect(201);
    const patientId = (patient.body as { id: string }).id;
    await raw.$executeRaw`
      INSERT INTO "patient_coverages" ("id", "tenantId", "patientId", "payerId", "updatedAt")
      VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${patientId}::uuid, ${payer.id}::uuid, now())`;
    const res = await as(
      api().delete(`/api/v1/payers/${payer.id}`),
      tokens.ADMIN,
    ).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Este pagador tiene coberturas o convenios asociados; desactívalo en lugar de retirarlo.',
    );
    expect(await names()).toContain('Con cobertura');
  });

  it('retirar con un convenio vivo da 409 y el pagador sigue (DX-105)', async () => {
    const payer = await createPayer({ name: 'Con convenio', type: 'OTHER' });
    await as(api().post('/api/v1/agreements'), tokens.ADMIN)
      .send({
        name: 'Convenio del pagador',
        payerId: payer.id,
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      })
      .expect(201);
    await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
      409,
    );
    expect(await names()).toContain('Con convenio');
  });

  it('la clínica B no ve ni edita los pagadores de A, y el mismo nombre no choca', async () => {
    expect(await names('', other.adminToken, other)).toEqual([]);
    const mine = await createPayer({
      name: 'Sistema Público Dos',
      type: 'PUBLIC_SYSTEM',
    });
    await as(
      api().patch(`/api/v1/payers/${mine.id}`),
      other.adminToken,
      other.host,
    )
      .send({ active: false })
      .expect(404);
    await as(
      api().delete(`/api/v1/payers/${mine.id}`),
      other.adminToken,
      other.host,
    ).expect(404);
    await as(api().post('/api/v1/payers'), other.adminToken, other.host)
      .send({ name: 'Sistema Público Dos', type: 'PUBLIC_SYSTEM' })
      .expect(201);
  });

  it('a country in the body is ignored and the response has no country', async () => {
    const created = await createPayer({
      name: 'Aseguradora Norte',
      type: 'INSURER',
      country: 'XX',
    });
    expect(created).not.toHaveProperty('country');
    expect(await storedCountry(created.id)).toBeNull();
  });

  it('legacy payer stored with a country keeps it when the API edits the payer', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326. Un
    // pagador guardado antes con país conserva ese dato: la API no lo toca.
    const legacy = await insertPayer('Plan Sur Antiguo', 'EPS_CO', 'CO');
    const res = await as(api().patch(`/api/v1/payers/${legacy}`), tokens.ADMIN)
      .send({ name: 'Plan Sur Renombrado', country: 'ES' })
      .expect(200);
    expect(res.body).not.toHaveProperty('country');
    expect((res.body as PayerBody).type).toBe('PUBLIC_SYSTEM');
    expect(await storedCountry(legacy)).toBe('CO');
  });

  it.each<[string, RegionalFixture]>([
    ['TOKYO', locationData(REGIONAL_TOKYO_FIXTURE)],
    ['NEWYORK', locationData(REGIONAL_NEW_YORK_FIXTURE, { country: 'ES' })],
  ])(
    "every payer type is created and covers a patient with no payer country, whatever the stored country of the clinic's location (%s)",
    async (name, regional) => {
      // el país de la sede lo obliga el enum hasta DX-312; no decide nada.
      const c = await registerClinic(app, `dx326-${name.toLowerCase()}`);
      await raw.location.updateMany({
        where: { tenantId: c.tenantId },
        data: regional,
      });
      const patientId = await newPatient('9001', c.adminToken, c.host);
      for (const type of PAYER_TYPES) {
        const payer = (
          await as(api().post('/api/v1/payers'), c.adminToken, c.host)
            .send({ name: `Pagador ${type}`, type })
            .expect(201)
        ).body as PayerBody;
        expect(payer.type).toBe(type);
        expect(payer).not.toHaveProperty('country');
        const body: Record<string, unknown> = { payerId: payer.id };
        if (type !== 'OTHER') body.memberNumber = 'AFI-778899';
        const cov = await as(
          api().post(`/api/v1/patients/${patientId}/coverages`),
          c.adminToken,
          c.host,
        )
          .send(body)
          .expect(201);
        expect(cov.body).toMatchObject({ payer: { id: payer.id, type } });
        expect((cov.body as { payer: object }).payer).not.toHaveProperty(
          'country',
        );
      }
    },
  );

  it('legacy payer rows read back with their generic type, same id and coverages', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
    const id = await insertPayer('Sistema Público Antiguo', 'EPS_CO', 'CO');
    const patientId = await newPatient('9002');
    await raw.$executeRaw`
      INSERT INTO "patient_coverages" ("id", "tenantId", "patientId", "payerId", "updatedAt")
      VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${patientId}::uuid, ${id}::uuid, now())`;
    const listed = await as(api().get('/api/v1/payers'), tokens.ADMIN).expect(
      200,
    );
    const payer = (listed.body as PayerBody[]).find((p) => p.id === id);
    expect(payer).toMatchObject({ id, type: 'PUBLIC_SYSTEM' });
    expect(payer).not.toHaveProperty('country');
    const covs = await as(
      api().get(`/api/v1/patients/${patientId}/coverages`),
      tokens.ADMIN,
    ).expect(200);
    const rows = covs.body as { payer: PayerBody }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].payer).toMatchObject({ id, type: 'PUBLIC_SYSTEM' });
    expect(rows[0].payer).not.toHaveProperty('country');
  });

  it('a payer stored with a generic code reads back unchanged', async () => {
    // Preparación de la fase 2: la fila ya guarda el código genérico.
    const id = await insertPayer('Aseguradora Fase Dos', 'INSURER', null);
    const listed = await as(api().get('/api/v1/payers'), tokens.ADMIN).expect(
      200,
    );
    expect((listed.body as PayerBody[]).find((p) => p.id === id)).toMatchObject(
      { id, type: 'INSURER' },
    );
  });
});
