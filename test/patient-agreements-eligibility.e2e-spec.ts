import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
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

// SEC-047 en HTTP real: asignar un convenio exige elegibilidad. La matriz
// rol (los 4) × cobertura (sin, viva, vencida, de otra clínica) × tipo de
// convenio (de un pagador externo o interno, pagador OTHER). Con un pagador
// externo hace falta una cobertura viva del paciente con ese pagador, sea cual
// sea el rol (400 en español si no); uno interno —cortesía, empleados— solo lo
// asigna ADMIN (403 en español). Y la reproducción de la auditoría: sin esa
// puerta, un ASSISTANT asignaba un convenio del 100 % y un DENTIST con tope del
// 10 % presupuestaba a 0.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ROLES = [
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
] as const;
type Role = (typeof ROLES)[number];
type Kind = 'pagador externo' | 'interno';
type CoverageCase = 'sin cobertura' | 'viva' | 'vencida' | 'de otra clínica';
const COVERAGE_CASES: CoverageCase[] = [
  'sin cobertura',
  'viva',
  'vencida',
  'de otra clínica',
];

const COVERAGE_REQUIRED =
  'Este convenio es de «Sura EPS»: elige una cobertura vigente del paciente con ese pagador. Si no la tiene, añádela antes en la ficha.';
const COVERAGE_NOT_LIVE =
  'La cobertura elegida no está vigente hoy: revisa sus fechas o elige otra.';
const COVERAGE_NOT_FOUND = 'Cobertura no encontrada.';
const ADMIN_ONLY =
  'Este convenio no es de un pagador externo (cortesía, empleados…): solo un administrador puede asignarlo. Si es una aseguradora, pide al administrador que reclasifique el pagador.';

/** Lo que debe responder cada combinación. */
function expected(
  role: Role,
  kind: Kind,
  coverage: CoverageCase,
): { status: number; message?: string } {
  if (kind === 'interno' && role !== ClinicRole.ADMIN) {
    return { status: 403, message: ADMIN_ONLY };
  }
  switch (coverage) {
    case 'viva':
      return { status: 200 };
    case 'vencida':
      return { status: 400, message: COVERAGE_NOT_LIVE };
    case 'de otra clínica':
      return { status: 400, message: COVERAGE_NOT_FOUND };
    case 'sin cobertura':
      return kind === 'interno'
        ? { status: 200 }
        : { status: 400, message: COVERAGE_REQUIRED };
  }
}

/** `YYYY-MM-DD` a `days` días de hoy (UTC); ±5 evita el borde de la zona. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Elegibilidad para asignar un convenio (e2e, SEC-047)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<Role, string>;
  let suraPayer: string;
  let cortesiaPayer: string;
  const agreementOf = {} as Record<Kind, string>;
  const payerOf = {} as Record<Kind, string>;
  /** Cobertura viva de un paciente de la OTRA clínica. */
  let foreignCoverage: string;
  let crown: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const url = (patientId: string) => `/api/v1/patients/${patientId}/agreement`;

  async function post(
    target: Clinic,
    path: string,
    body: Record<string, unknown>,
    token = target.adminToken,
  ): Promise<string> {
    const res = await as(api().post(path), token, target.host)
      .send(body)
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (target: Clinic, firstName: string) =>
    post(target, '/api/v1/patients', {
      docType: 'NATIONAL_ID',
      sex: Sex.F,
      lastName: 'Elegibilidad',
      docNumber: String(Math.floor(Math.random() * 1e9)),
      firstName,
    });

  async function coverageFor(
    patientId: string,
    payerId: string,
    coverage: CoverageCase,
  ): Promise<string | undefined> {
    switch (coverage) {
      case 'sin cobertura':
        return undefined;
      case 'de otra clínica':
        return foreignCoverage;
      case 'viva':
        return post(clinic, `/api/v1/patients/${patientId}/coverages`, {
          payerId,
          memberNumber: '1020304050',
        });
      case 'vencida':
        return post(clinic, `/api/v1/patients/${patientId}/coverages`, {
          payerId,
          memberNumber: '1020304050',
          validFrom: dayFromNow(-60),
          validTo: dayFromNow(-5),
        });
    }
  }

  const assignmentEvents = async (patientId: string) =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, patientId },
        select: { metadata: true },
      })
    ).filter(
      (e) =>
        (e.metadata as { reason?: string }).reason === 'AGREEMENT_ASSIGNED',
    ).length;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'sec047-eleg');
    other = await registerClinic(app, 'sec047-eleg-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ] as const) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    suraPayer = await post(clinic, '/api/v1/payers', {
      name: 'Sura EPS',
      type: 'PUBLIC_SYSTEM',
    });
    cortesiaPayer = await post(clinic, '/api/v1/payers', {
      name: 'Cortesía de la clínica',
      type: 'OTHER',
    });
    payerOf['pagador externo'] = suraPayer;
    payerOf.interno = cortesiaPayer;
    agreementOf['pagador externo'] = await post(clinic, '/api/v1/agreements', {
      name: 'Sura EPS 100 %',
      payerId: suraPayer,
      kind: 'PERCENT_DISCOUNT',
      percent: 100,
    });
    agreementOf.interno = await post(clinic, '/api/v1/agreements', {
      name: 'Cortesía socios 100 %',
      payerId: cortesiaPayer,
      kind: 'PERCENT_DISCOUNT',
      percent: 100,
    });

    // La otra clínica tiene su propio pagador con el MISMO nombre y una
    // cobertura viva: su id no vale en esta clínica.
    const foreignPayer = await post(other, '/api/v1/payers', {
      name: 'Sura EPS',
      type: 'PUBLIC_SYSTEM',
    });
    const foreignPatient = await createPatient(other, 'Ajena');
    foreignCoverage = await post(
      other,
      `/api/v1/patients/${foreignPatient}/coverages`,
      { payerId: foreignPayer, memberNumber: '1020304050' },
    );

    crown = await post(clinic, '/api/v1/catalog/items', {
      code: 'SEC047-COR',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Corona de zirconio',
      color: '#2A2B3C',
      defaultPrice: 2000000,
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('el convenio dice de qué tipo es su pagador (la web decide qué pedir)', async () => {
    const res = await as(api().get('/api/v1/agreements'), tokens.RECEPTION)
      .query({ includeInactive: true })
      .expect(200);
    const types = Object.fromEntries(
      (res.body as { name: string; payer: { type: string } }[]).map((a) => [
        a.name,
        a.payer.type,
      ]),
    );
    expect(types).toEqual({
      'Cortesía socios 100 %': 'OTHER',
      'Sura EPS 100 %': 'PUBLIC_SYSTEM',
    });
  });

  const matrix = ROLES.flatMap((role) =>
    (['pagador externo', 'interno'] as Kind[]).flatMap((kind) =>
      COVERAGE_CASES.map((coverage) => ({
        role,
        kind,
        coverage,
        ...expected(role, kind, coverage),
      })),
    ),
  );

  it.each(matrix)(
    '$role · convenio $kind · cobertura $coverage → $status',
    async ({ role, kind, coverage, status, message }) => {
      const patient = await createPatient(clinic, `${role} ${kind}`);
      const coverageId = await coverageFor(patient, payerOf[kind], coverage);
      const res = await as(api().put(url(patient)), tokens[role]).send({
        agreementId: agreementOf[kind],
        ...(coverageId ? { coverageId } : {}),
      });
      expect(res.status).toBe(status);
      if (message) {
        expect((res.body as { message: string }).message).toBe(message);
      }

      const live = await raw.patientAgreement.findMany({
        where: { patientId: patient, deletedAt: null },
        select: { agreementId: true, coverageId: true },
      });
      if (status === 200) {
        expect(live).toEqual([
          { agreementId: agreementOf[kind], coverageId: coverageId ?? null },
        ]);
        expect(await assignmentEvents(patient)).toBe(1);
      } else {
        // Nada escrito ni auditado como asignado.
        expect(live).toEqual([]);
        expect(await assignmentEvents(patient)).toBe(0);
      }
    },
  );

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
    '%s asigna un convenio OTRO si el paciente trae de ese pagador la cobertura MIGRADA del texto libre de aseguradora anterior a DX-153',
    async (role) => {
      const patient = await createPatient(clinic, `Migrada ${role}`);
      const coverageId = (await coverageFor(patient, cortesiaPayer, 'viva'))!;
      // La API no crea coberturas migradas: solo el relleno de DX-153.
      await raw.patientCoverage.update({
        where: { id: coverageId },
        data: { migratedFromInsurerEps: true },
      });
      await as(api().put(url(patient)), tokens[role])
        .send({ agreementId: agreementOf.interno, coverageId })
        .expect(200);
      // La misma cobertura sin la marca no habilita a nadie más que al ADMIN.
      const other = await createPatient(clinic, `No migrada ${role}`);
      const plain = (await coverageFor(other, cortesiaPayer, 'viva'))!;
      const res = await as(api().put(url(other)), tokens[role])
        .send({ agreementId: agreementOf.interno, coverageId: plain })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(ADMIN_ONLY);
    },
  );

  it('legacy OTRO payer stays internal: a RECEPTION assignment is 403', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326. Un
    // pagador guardado con el código anterior OTRO se lee OTHER (interno):
    // SEC-047 sigue pidiendo ADMIN para su convenio.
    const [{ id: payerId }] = await raw.$queryRaw<{ id: string }[]>`
      INSERT INTO "payers" ("id", "tenantId", "name", "type", "updatedAt")
      VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, 'Cortesía empleados', 'OTRO', now())
      RETURNING id::text AS id`;
    const agreementId = await post(clinic, '/api/v1/agreements', {
      name: 'Cortesía empleados 100 %',
      payerId,
      kind: 'PERCENT_DISCOUNT',
      percent: 100,
    });
    const patient = await createPatient(clinic, 'Legado interno');

    const denied = await as(api().put(url(patient)), tokens.RECEPTION)
      .send({ agreementId })
      .expect(403);
    expect((denied.body as { message: string }).message).toBe(ADMIN_ONLY);
    await as(api().put(url(patient)), tokens.ADMIN)
      .send({ agreementId })
      .expect(200);

    const res = await as(api().get('/api/v1/agreements'), tokens.RECEPTION)
      .query({ includeInactive: true })
      .expect(200);
    const listed = (
      res.body as { id: string; payer: { id: string; type: string } }[]
    ).find((a) => a.id === agreementId);
    expect(listed?.payer).toMatchObject({ id: payerId, type: 'OTHER' });
    const assigned = await as(api().get(url(patient)), tokens.RECEPTION).expect(
      200,
    );
    expect(
      (assigned.body as { current: { agreement: { payer: { type: string } } } })
        .current.agreement.payer.type,
    ).toBe('OTHER');
  });

  it('legacy EPS_CO payer stays external: an assignment without coverage is 400', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326. Un
    // pagador guardado con el código anterior EPS_CO se lee PUBLIC_SYSTEM
    // (externo): SEC-047 pide cobertura viva, también a ADMIN.
    const [{ id: payerId }] = await raw.$queryRaw<{ id: string }[]>`
      INSERT INTO "payers" ("id", "tenantId", "name", "type", "country", "updatedAt")
      VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, 'Plan Sur antiguo',
              'EPS_CO', 'CO', now())
      RETURNING id::text AS id`;
    const agreementId = await post(clinic, '/api/v1/agreements', {
      name: 'Plan Sur antiguo 100 %',
      payerId,
      kind: 'PERCENT_DISCOUNT',
      percent: 100,
    });
    const patient = await createPatient(clinic, 'Legado externo');
    for (const token of [tokens.RECEPTION, tokens.ADMIN]) {
      const res = await as(api().put(url(patient)), token)
        .send({ agreementId })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        COVERAGE_REQUIRED.replace('Sura EPS', 'Plan Sur antiguo'),
      );
    }
  });

  it('la cobertura migrada no se puede marcar por la API', async () => {
    const patient = await createPatient(clinic, 'Marca');
    const coverageId = (await coverageFor(patient, cortesiaPayer, 'viva'))!;
    await as(
      api().patch(`/api/v1/patients/${patient}/coverages/${coverageId}`),
      tokens.ADMIN,
    ).send({ migratedFromInsurerEps: true });
    const row = await raw.patientCoverage.findUniqueOrThrow({
      where: { id: coverageId },
      select: { migratedFromInsurerEps: true },
    });
    expect(row.migratedFromInsurerEps).toBe(false);
  });

  it('una cobertura viva de OTRO pagador no habilita el convenio: 400', async () => {
    const patient = await createPatient(clinic, 'Otro pagador');
    const coverageId = await coverageFor(patient, cortesiaPayer, 'viva');
    const res = await as(api().put(url(patient)), tokens.RECEPTION)
      .send({ agreementId: agreementOf['pagador externo'], coverageId })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      'La cobertura elegida no es de ese pagador.',
    );
  });

  it('una cobertura retirada ya no vale: 400', async () => {
    const patient = await createPatient(clinic, 'Retirada');
    // La primera es la principal; la de Sura, la segunda, se puede retirar.
    await coverageFor(patient, cortesiaPayer, 'viva');
    const coverageId = (await coverageFor(patient, suraPayer, 'viva'))!;
    await as(
      api().delete(`/api/v1/patients/${patient}/coverages/${coverageId}`),
      tokens.ADMIN,
    ).expect(204);
    const res = await as(api().put(url(patient)), tokens.ADMIN)
      .send({ agreementId: agreementOf['pagador externo'], coverageId })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(COVERAGE_NOT_FOUND);
  });

  it('reproducción de la auditoría: ni el ASSISTANT asigna el 100 % sin cobertura ni el DENTIST presupuesta a 0', async () => {
    const patient = await createPatient(clinic, 'Conocido');
    const plan = await post(
      clinic,
      `/api/v1/patients/${patient}/treatment-plans`,
      { currency: 'COP' },
      tokens.DENTIST,
    );
    const item = (body: Record<string, unknown>) =>
      as(
        api().post(`/api/v1/treatment-plans/${plan}/items`),
        tokens.DENTIST,
      ).send({ toothNumber: '36', catalogItemId: crown, ...body });

    // Sin convenio, el tope del 10 % del DENTIST frena el precio 0.
    await item({ price: 0 }).expect(403);

    // El ASSISTANT ya no puede colarle un convenio del 100 %.
    await as(api().put(url(patient)), tokens.ASSISTANT)
      .send({ agreementId: agreementOf['pagador externo'] })
      .expect(400);
    await as(api().put(url(patient)), tokens.ASSISTANT)
      .send({ agreementId: agreementOf.interno })
      .expect(403);

    // Sin convenio asignado, el ítem sale a precio de catálogo.
    const res = await item({}).expect(201);
    expect(res.body).toMatchObject({
      price: 2000000,
      catalogPrice: 2000000,
      priceSource: 'CATALOG',
    });
  });

  it('desde otra clínica, el paciente no existe (404) aunque traiga una cobertura válida allí', async () => {
    const patient = await createPatient(clinic, 'Aislada');
    await as(api().put(url(patient)), other.adminToken, other.host)
      .send({
        agreementId: agreementOf['pagador externo'],
        coverageId: foreignCoverage,
      })
      .expect(404);
  });
});
