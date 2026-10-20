import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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
// y retiro solo ADMIN), duplicado sin mayúsculas ni tildes, coherencia tipo y
// país, desactivar frente a retirar, y aislamiento entre clínicas.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface PayerBody {
  id: string;
  name: string;
  type: string;
  country: string | null;
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

  it('ADMIN crea un pagador con tipo y país', async () => {
    const payer = await createPayer({
      name: '  Sanitas   EPS ',
      type: 'EPS_CO',
      country: 'CO',
    });
    expect(payer).toMatchObject({
      name: 'Sanitas EPS',
      type: 'EPS_CO',
      country: 'CO',
      active: true,
    });
  });

  it('recepción crea (201) y el país es opcional para empresa', async () => {
    const payer = await createPayer(
      { name: 'Empresa Mostrador', type: 'EMPRESA' },
      tokens.RECEPTION,
    );
    expect(payer).toMatchObject({ type: 'EMPRESA', country: null });
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

  it('MUTUA_ES con país CO da 400 con el mensaje', async () => {
    const res = await as(api().post('/api/v1/payers'), tokens.ADMIN)
      .send({ name: 'Mutua rara', type: 'MUTUA_ES', country: 'CO' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'El tipo de pagador no corresponde con el país.',
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

  it('country null vacía el país de una empresa y se rechaza en una mutua', async () => {
    const empresa = await createPayer({
      name: 'Empresa con país',
      type: 'EMPRESA',
      country: 'ES',
    });
    const ok = await as(
      api().patch(`/api/v1/payers/${empresa.id}`),
      tokens.ADMIN,
    )
      .send({ country: null })
      .expect(200);
    expect((ok.body as PayerBody).country).toBeNull();

    const mutua = await createPayer({
      name: 'Mutua con país',
      type: 'MUTUA_ES',
      country: 'ES',
    });
    const bad = await as(
      api().patch(`/api/v1/payers/${mutua.id}`),
      tokens.ADMIN,
    )
      .send({ country: null })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain(
      'El tipo de pagador no corresponde con el país.',
    );
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
      'Este pagador tiene coberturas asociadas; desactívalo en lugar de retirarlo.',
    );
    expect(await names()).toContain('Con cobertura');
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
