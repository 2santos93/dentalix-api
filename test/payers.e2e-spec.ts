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
      name: '  Sanitas   EPS ',
      type: 'EPS_CO',
      country: 'CO',
    });
    expect(payer).toMatchObject({
      name: 'Sanitas EPS',
      type: 'PUBLIC_SYSTEM',
      active: true,
    });
    expect(payer).not.toHaveProperty('country');
  });

  it('recepción crea (201)', async () => {
    const payer = await createPayer(
      { name: 'Empresa Mostrador', type: 'EMPRESA' },
      tokens.RECEPTION,
    );
    expect(payer.type).toBe('EMPLOYER');
    expect(payer).not.toHaveProperty('country');
  });

  it('el dentista no crea (403)', async () => {
    await as(api().post('/api/v1/payers'), tokens.DENTIST)
      .send({ name: 'Nada', type: 'OTRO' })
      .expect(403);
  });

  it('un nombre que solo cambia en mayúsculas o tildes da 409 en español', async () => {
    await createPayer({ name: 'Seguros Bolívar', type: 'OTRO' });
    const res = await as(api().post('/api/v1/payers'), tokens.ADMIN)
      .send({ name: ' SEGUROS  bolivar', type: 'OTRO' })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Ya existe un pagador con ese nombre.',
    );
  });

  it('any type with or without a country in the body is 201', async () => {
    const created = [
      await createPayer({
        name: 'Mutua rara',
        type: 'MUTUA_ES',
        country: 'CO',
      }),
      await createPayer({ name: 'Aseguradora Norte', type: 'INSURER' }),
      await createPayer({
        name: 'Sistema Público Central',
        type: 'PUBLIC_SYSTEM',
        country: 'ES',
      }),
    ];
    expect(created.map((p) => p.type)).toEqual([
      'INSURER',
      'INSURER',
      'PUBLIC_SYSTEM',
    ]);
    for (const payer of created) expect(payer).not.toHaveProperty('country');
    for (const payer of created) {
      await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
        204,
      );
    }
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
        'Sanitas EPS',
        'Seguros Bolívar',
      ]);
    }
  });

  it('desactivar lo oculta del listado y includeInactive lo muestra', async () => {
    const payer = await createPayer({
      name: 'Prepagada Z',
      type: 'PREPAGADA_CO',
      country: 'CO',
    });
    const res = await as(
      api().patch(`/api/v1/payers/${payer.id}`),
      tokens.ADMIN,
    )
      .send({ active: false })
      .expect(200);
    expect((res.body as PayerBody).active).toBe(false);
    expect(await names()).not.toContain('Prepagada Z');
    expect(await names('?includeInactive=true')).toContain('Prepagada Z');
  });

  it('el PATCH de la web anterior con country null da 200 y la respuesta no lleva country', async () => {
    const empresa = await createPayer({
      name: 'Empresa con país',
      type: 'EMPRESA',
      country: 'ES',
    });
    const ok = await as(
      api().patch(`/api/v1/payers/${empresa.id}`),
      tokens.ADMIN,
    )
      .send({ name: 'Empresa con país', type: 'EMPRESA', country: null })
      .expect(200);
    expect((ok.body as PayerBody).type).toBe('EMPLOYER');
    expect(ok.body).not.toHaveProperty('country');

    const mutua = await createPayer({
      name: 'Mutua con país',
      type: 'MUTUA_ES',
      country: 'ES',
    });
    const retyped = await as(
      api().patch(`/api/v1/payers/${mutua.id}`),
      tokens.ADMIN,
    )
      .send({ type: 'OTHER', country: null })
      .expect(200);
    expect((retyped.body as PayerBody).type).toBe('OTHER');
    expect(retyped.body).not.toHaveProperty('country');
  });

  it('legacy type codes in the body are accepted as their generic type during the rollout', async () => {
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
    const payer = await createPayer({ name: 'Null no', type: 'OTRO' });
    for (const body of [{ name: null }, { type: null }, { active: null }]) {
      await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
        .send(body)
        .expect(400);
    }
  });

  it('tras retirar un pagador, otro con el mismo nombre se crea (201)', async () => {
    const first = await createPayer({
      name: 'Nombre reutilizable',
      type: 'OTRO',
    });
    await as(api().delete(`/api/v1/payers/${first.id}`), tokens.ADMIN).expect(
      204,
    );
    const second = await createPayer({
      name: 'nombre REUTILIZABLE',
      type: 'OTRO',
    });
    expect(second.id).not.toBe(first.id);
  });

  it('un nombre que coincide con un pagador DESACTIVADO da un 409 que lo dice', async () => {
    const off = await createPayer({ name: 'Colsanitas Off', type: 'OTRO' });
    await as(api().patch(`/api/v1/payers/${off.id}`), tokens.ADMIN)
      .send({ active: false })
      .expect(200);
    const res = await as(api().post('/api/v1/payers'), tokens.RECEPTION)
      .send({ name: 'colsanitas off', type: 'OTRO' })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Ya existe un pagador con ese nombre, pero está desactivado; pídele a administración que lo reactive.',
    );
    const other = await createPayer({ name: 'Colsanitas Otro', type: 'OTRO' });
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
    const payer = await createPayer({ name: 'Otro Pagador', type: 'OTRO' });
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
      .send({ name: 'sanitas eps' })
      .expect(409);
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.RECEPTION)
      .send({ name: 'X Pagador' })
      .expect(403);
  });

  it('retirar sin coberturas da 204 y deja de listarse', async () => {
    const payer = await createPayer({ name: 'Para retirar', type: 'OTRO' });
    await as(api().delete(`/api/v1/payers/${payer.id}`), tokens.ADMIN).expect(
      204,
    );
    expect(await names('?includeInactive=true')).not.toContain('Para retirar');
    await as(api().patch(`/api/v1/payers/${payer.id}`), tokens.ADMIN)
      .send({ active: true })
      .expect(404);
  });

  it('retirar con una cobertura viva da 409 y el pagador sigue', async () => {
    const payer = await createPayer({ name: 'Con cobertura', type: 'OTRO' });
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
    const payer = await createPayer({ name: 'Con convenio', type: 'OTRO' });
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
      name: 'Sanitas EPS Dos',
      type: 'EPS_CO',
      country: 'CO',
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
      .send({ name: 'Sanitas EPS Dos', type: 'EPS_CO', country: 'CO' })
      .expect(201);
  });
});
