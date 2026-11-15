import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { seedParProviderRates } from './support/par-provider-rates';
import { PATIENT_MERGE_FORBIDDEN_MESSAGE } from '../src/modules/patient-merge/presentation/patient-duplicates.controller';
import { PATIENT_MERGED } from '../src/modules/patients/application/use-cases/get-patient.use-case';

// DX-266 en HTTP real: «Posibles duplicados» (motivos, sede, «No es
// duplicado»), vista previa y fusión con su saldo (estado de cuenta igual
// antes y después), la ficha y la búsqueda antiguas que llevan al conservado,
// la auditoría (lo movido por tipo y cantidad, sin datos clínicos), solo
// ADMIN y nunca entre clínicas. DIRECT_URL solo siembra lo que la API no deja
// crear (un duplicado de documento «heredado» de antes de DX-287) y lee la
// auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

let dropParRates: (() => Promise<void>) | undefined;

interface Pair {
  patients: { id: string; firstName: string; lastName: string }[];
  reasons: string[];
}

interface Summary {
  currency: string;
  budgeted: number;
  paid: number;
  balance: number;
}

describe('Pacientes duplicados y fusión (e2e, DX-266)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let principalId: string;
  let altamiraId: string;
  let catalogItemId: string;
  const ids = {} as Record<
    | 'docA'
    | 'docB'
    | 'luisA'
    | 'luisB'
    | 'carmenA'
    | 'carmenB'
    | 'pedro'
    | 'otherPatient',
    string
  >;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token = clinic.adminToken,
    host = clinic.host,
  ) => req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPatient(
    body: Record<string, unknown>,
    target: Clinic = clinic,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/patients'),
      target.adminToken,
      target.host,
    )
      .send({ docType: 'NATIONAL_ID', sex: 'F', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function planWithPayment(
    patientId: string,
    price: number,
    paid: number,
  ): Promise<void> {
    const plan = await as(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
    )
      .send({ currency: 'USD' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const item = await as(api().post(`/api/v1/treatment-plans/${planId}/items`))
      .send({ toothNumber: '11', catalogItemId, price })
      .expect(201);
    await as(
      api().patch(
        `/api/v1/treatment-plans/${planId}/items/${(item.body as { id: string }).id}`,
      ),
    )
      .send({ status: 'ACCEPTED' })
      .expect(200);
    await as(api().post(`/api/v1/treatment-plans/${planId}/payments`))
      .send({
        amount: paid,
        currency: 'USD',
        paidAt: '2026-07-01',
        method: 'CASH',
      })
      .expect(201);
  }

  async function statement(patientId: string): Promise<Summary[]> {
    const res = await as(
      api().get(`/api/v1/patients/${patientId}/account-statement`),
    ).expect(200);
    return (res.body as { summary: Summary[] }).summary;
  }

  async function list(
    query = '',
    token = clinic.adminToken,
    host = clinic.host,
  ): Promise<{ items: Pair[]; total: number }> {
    const res = await as(
      api().get(`/api/v1/patient-duplicates${query}`),
      token,
      host,
    ).expect(200);
    return res.body as { items: Pair[]; total: number };
  }

  const pairOf = (items: Pair[], a: string, b: string) =>
    items.find((p) => {
      const got = p.patients.map((x) => x.id).sort();
      return got[0] === [a, b].sort()[0] && got[1] === [a, b].sort()[1];
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    dropParRates = await seedParProviderRates(raw);
    clinic = await registerClinic(app, 'dx266-e2e', REGIONAL_CARACAS_FIXTURE);
    other = await registerClinic(
      app,
      'dx266-e2e-otra',
      REGIONAL_CARACAS_FIXTURE,
    );
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    principalId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    altamiraId = (
      (
        await as(api().post('/api/v1/locations'))
          .send(
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Altamira' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX266-RESINA',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    // Documento: «V-12.345.678» por la API y «v12345678» de antes de DX-287
    // (la API ya no deja dar de alta el mismo documento escrito distinto).
    ids.docA = await createPatient({
      firstName: 'María José',
      lastName: 'Pérez',
      docNumber: 'V-12.345.678',
      email: 'mariajose.perez@example.com',
    });
    ids.docB = (
      await raw.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: 'Maria',
          lastName: 'Perez Gil',
          docNumber: 'v12345678',
          documentType: 'NATIONAL_ID',
        },
      })
    ).id;
    // Nombre + nacimiento (sin documento uno de ellos).
    ids.luisA = await createPatient({
      firstName: 'Luis',
      lastName: 'Rodríguez',
      docNumber: 'V-20111222',
      birthDate: '1980-05-01',
      sex: 'M',
    });
    ids.luisB = await createPatient({
      firstName: 'luis',
      lastName: 'Rodriguez',
      birthDate: '1980-05-01',
      sex: 'M',
      email: 'luis.rodriguez@example.com',
    });
    // Teléfono + nombre; Pedro comparte teléfono (familia) y no es pareja.
    ids.carmenA = await createPatient({
      firstName: 'Carmen',
      lastName: 'Rondón',
      docNumber: 'V-9876543',
      phone: '+58 412 555 1234',
    });
    ids.carmenB = await createPatient({
      firstName: 'Carmen Elena',
      lastName: 'Rondón Díaz',
      phone: '0412-5551234',
    });
    ids.pedro = await createPatient({
      firstName: 'Pedro',
      lastName: 'Rondón',
      phone: '04125551234',
      sex: 'M',
    });
    ids.otherPatient = await createPatient(
      { firstName: 'Luis', lastName: 'Rodríguez', birthDate: '1980-05-01' },
      other,
    );

    // Luis A atendido en Altamira (filtro por sede); saldo en los dos.
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: altamiraId,
        patientId: ids.luisA,
        providerId: clinic.adminUserId,
        start: new Date('2026-06-10T13:00:00.000Z'),
        end: new Date('2026-06-10T13:30:00.000Z'),
        status: 'COMPLETED',
      },
    });
    await planWithPayment(ids.luisA, 100, 30);
    await planWithPayment(ids.luisB, 200, 50);
  }, 120_000);

  afterAll(async () => {
    await dropParRates?.();
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('solo ADMIN: los demás roles reciben 403 en español en las cuatro rutas', async () => {
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const token = tokens[role];
      const calls = [
        as(api().get('/api/v1/patient-duplicates'), token),
        as(api().post('/api/v1/patient-duplicates/dismissals'), token).send({
          patientIds: [ids.luisA, ids.luisB],
        }),
        as(
          api().get(
            `/api/v1/patient-duplicates/merge-preview?keptId=${ids.luisA}&absorbedId=${ids.luisB}`,
          ),
          token,
        ),
        as(api().post('/api/v1/patient-duplicates/merge'), token).send({
          keptId: ids.luisA,
          absorbedId: ids.luisB,
        }),
      ];
      for (const call of calls) {
        const res = await call.expect(403);
        expect((res.body as { message: string }).message).toBe(
          PATIENT_MERGE_FORBIDDEN_MESSAGE,
        );
      }
    }
    expect(
      await raw.patient.count({
        where: { id: { in: [ids.luisA, ids.luisB] }, deletedAt: null },
      }),
    ).toBe(2);
  });

  it('detecta por documento normalizado, nombre + nacimiento y teléfono + nombre, con el motivo; la familia que comparte teléfono no', async () => {
    const { items, total } = await list();
    expect(total).toBe(3);
    expect(pairOf(items, ids.docA, ids.docB)?.reasons).toEqual(['DOCUMENT']);
    expect(pairOf(items, ids.luisA, ids.luisB)?.reasons).toEqual([
      'NAME_BIRTHDATE',
    ]);
    expect(pairOf(items, ids.carmenA, ids.carmenB)?.reasons).toEqual([
      'PHONE_NAME',
    ]);
    expect(pairOf(items, ids.carmenA, ids.pedro)).toBeUndefined();
    // Primero las de documento.
    expect(items[0].reasons).toContain('DOCUMENT');
    // Sin datos clínicos en la lista.
    expect(Object.keys(items[0].patients[0]).sort()).toEqual(
      [
        'birthDate',
        'createdAt',
        'docNumber',
        'docTypeLabel',
        'documentType',
        'email',
        'firstName',
        'id',
        'lastAttentionAt',
        'lastName',
        'patientCode',
        'phone',
      ].sort(),
    );
  });

  it('filtra por sede: solo las parejas con una cita o el saldo en ella', async () => {
    const { items } = await list(`?locationId=${altamiraId}`);
    expect(items.map((p) => p.reasons)).toEqual([['NAME_BIRTHDATE']]);
    expect(pairOf(items, ids.luisA, ids.luisB)).toBeDefined();
    const page = await list('?pageSize=1&page=2');
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('«No es duplicado» hace que la pareja deje de salir (idempotente) y queda en la auditoría de los dos', async () => {
    for (let i = 0; i < 2; i++) {
      await as(api().post('/api/v1/patient-duplicates/dismissals'))
        .send({ patientIds: [ids.carmenB, ids.carmenA] })
        .expect(204);
    }
    const { items } = await list();
    expect(pairOf(items, ids.carmenA, ids.carmenB)).toBeUndefined();
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          patientId: { in: [ids.carmenA, ids.carmenB] },
          metadata: { path: ['reason'], equals: 'PATIENT_DUPLICATE_DISMISSED' },
        },
      }),
    ).toBe(2);
    await as(api().post('/api/v1/patient-duplicates/dismissals'))
      .send({ patientIds: [ids.carmenA, ids.carmenA] })
      .expect(400);
  });

  it('vista previa: los dos campo a campo, lo que tiene cada uno y sin bloqueos', async () => {
    const res = await as(
      api().get(
        `/api/v1/patient-duplicates/merge-preview?keptId=${ids.luisA}&absorbedId=${ids.luisB}`,
      ),
    ).expect(200);
    const body = res.body as {
      kept: {
        id: string;
        fields: Record<string, unknown>;
        counts: { category: string; count: number }[];
      };
      absorbed: { fields: Record<string, unknown> };
      blockers: string[];
      absorbedLiveLinks: { total: number };
    };
    expect(body.kept.id).toBe(ids.luisA);
    expect(body.kept.fields.docNumber).toBe('V-20111222');
    expect(body.absorbed.fields.email).toBe('luis.rodriguez@example.com');
    expect(body.kept.fields.birthDate).toBe('1980-05-01');
    expect(body.kept.counts).toEqual(
      expect.arrayContaining([
        { category: 'appointments', count: 1 },
        { category: 'treatmentPlans', count: 1 },
        { category: 'payments', count: 1 },
      ]),
    );
    expect(body.blockers).toEqual([]);
    expect(body.absorbedLiveLinks.total).toBe(0);
  });

  it('fusiona: el saldo total es el mismo, la ficha y la búsqueda antiguas llevan al conservado y la auditoría dice lo movido sin datos clínicos', async () => {
    const before = [
      ...(await statement(ids.luisA)),
      ...(await statement(ids.luisB)),
    ];
    const sum = (rows: Summary[], key: keyof Summary) =>
      rows.reduce((acc, r) => acc + Number(r[key]), 0);
    const res = await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({
        keptId: ids.luisA,
        absorbedId: ids.luisB,
        fields: { email: 'ABSORBED' },
      })
      .expect(201);
    const result = res.body as {
      patientId: string;
      moved: { table: string; count: number }[];
      fieldsFromAbsorbed: string[];
    };
    expect(result.patientId).toBe(ids.luisA);
    expect(result.fieldsFromAbsorbed).toEqual(['email']);
    expect(result.moved).toEqual(
      expect.arrayContaining([
        { table: 'treatment_plans', count: 1 },
        { table: 'treatment_plan_items', count: 1 },
        { table: 'payments', count: 1 },
      ]),
    );

    // Saldo: presupuestado 300, abonado 80, saldo 220 USD, igual que la suma.
    const after = await statement(ids.luisA);
    expect(after).toHaveLength(1);
    expect(after[0].currency).toBe('USD');
    for (const key of ['budgeted', 'paid', 'balance'] as const) {
      expect(Number(after[0][key])).toBeCloseTo(sum(before, key), 2);
    }
    expect(Number(after[0].balance)).toBeCloseTo(220, 2);

    // La ficha del conservado tiene el email elegido; la del absorbido lleva a él.
    const kept = await as(api().get(`/api/v1/patients/${ids.luisA}`)).expect(
      200,
    );
    expect((kept.body as { email: string }).email).toBe(
      'luis.rodriguez@example.com',
    );
    const gone = await as(api().get(`/api/v1/patients/${ids.luisB}`)).expect(
      404,
    );
    expect(gone.body).toMatchObject({
      code: PATIENT_MERGED,
      mergedIntoId: ids.luisA,
    });
    // Ya no sale en «Posibles duplicados».
    expect(pairOf((await list()).items, ids.luisA, ids.luisB)).toBeUndefined();

    // Auditoría: un evento en cada paciente, con lo movido por tabla y
    // cantidad; nada de la historia clínica ni importes.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'PATIENT_MERGED' },
      },
      select: {
        patientId: true,
        actorUserId: true,
        action: true,
        metadata: true,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.patientId).sort()).toEqual(
      [ids.luisA, ids.luisB].sort(),
    );
    const keptEvent = events.find((e) => e.patientId === ids.luisA)!;
    expect(keptEvent.actorUserId).toBe(clinic.adminUserId);
    expect(keptEvent.action).toBe('UPDATE');
    expect(keptEvent.metadata).toMatchObject({
      reason: 'PATIENT_MERGED',
      changedFields: ['email'],
      patientMerge: {
        role: 'KEPT',
        otherPatientId: ids.luisB,
        moved: expect.objectContaining({
          payments: 1,
          treatment_plans: 1,
        }) as unknown,
      },
    });
    const text = JSON.stringify(events);
    expect(text).not.toContain('luis.rodriguez@example.com');
    expect(text).not.toContain('Rodr');

    // Otra vez: el absorbido ya no está vivo.
    const again = await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({ keptId: ids.luisA, absorbedId: ids.luisB })
      .expect(409);
    expect((again.body as { code: string }).code).toBe(
      'MERGE_PATIENT_INACTIVE',
    );
  });

  it('buscar el documento antiguo del absorbido lleva al conservado', async () => {
    await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({
        keptId: ids.docB,
        absorbedId: ids.docA,
        fields: { firstName: 'ABSORBED' },
      })
      .expect(201);
    const kept = await as(api().get(`/api/v1/patients/${ids.docB}`)).expect(
      200,
    );
    expect(kept.body).toMatchObject({
      firstName: 'María José',
      lastName: 'Perez Gil',
      docNumber: 'v12345678',
    });
    // «V-12.345.678» solo lo tiene escrito así el absorbido.
    const search = await as(
      api().get(`/api/v1/patients?query=${encodeURIComponent('V-12.345.678')}`),
    ).expect(200);
    const body = search.body as { items: { id: string }[]; total: number };
    expect(body.items.map((p) => p.id)).toEqual([ids.docB]);
    expect(body.total).toBe(1);
  });

  it('documento elegido del absorbido: pasa al conservado (el absorbido ya no lo ocupa)', async () => {
    await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({
        keptId: ids.carmenB,
        absorbedId: ids.carmenA,
        fields: { document: 'ABSORBED' },
      })
      .expect(201);
    const kept = await as(api().get(`/api/v1/patients/${ids.carmenB}`)).expect(
      200,
    );
    expect(kept.body).toMatchObject({
      firstName: 'Carmen Elena',
      docType: 'NATIONAL_ID',
      docNumber: 'V-9876543',
    });
  });

  it('validación: mismo paciente o ids que no son UUID → 400 en español', async () => {
    const same = await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({ keptId: ids.pedro, absorbedId: ids.pedro })
      .expect(400);
    expect((same.body as { message: string }).message).toMatch(/distintos/);
    await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({ keptId: 'x', absorbedId: ids.pedro })
      .expect(400);
    await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({
        keptId: ids.pedro,
        absorbedId: ids.carmenB,
        fields: { email: 'AMBOS' },
      })
      .expect(400);
  });

  // ISOLATION_COVERS: GET /patient-duplicates ?locationId
  // ISOLATION_COVERS: POST /patient-duplicates/dismissals body.patientIds[]
  // ISOLATION_COVERS: GET /patient-duplicates/merge-preview ?keptId
  // ISOLATION_COVERS: GET /patient-duplicates/merge-preview ?absorbedId
  // ISOLATION_COVERS: POST /patient-duplicates/merge body.keptId
  // ISOLATION_COVERS: POST /patient-duplicates/merge body.absorbedId
  it('nunca entre clínicas: B no ve parejas de A ni puede descartar, previsualizar ni fusionar con pacientes de A (404) y nada de A cambia', async () => {
    const before = await raw.patient.findMany({
      where: { tenantId: clinic.tenantId },
      select: { id: true, deletedAt: true, mergedIntoId: true, email: true },
      orderBy: { id: 'asc' },
    });
    const asB = (req: request.Test) => as(req, other.adminToken, other.host);
    expect((await list('', other.adminToken, other.host)).items).toEqual([]);
    expect(
      (await list(`?locationId=${principalId}`, other.adminToken, other.host))
        .items,
    ).toEqual([]);
    await asB(api().post('/api/v1/patient-duplicates/dismissals'))
      .send({ patientIds: [ids.pedro, ids.otherPatient] })
      .expect(404);
    for (const [keptId, absorbedId] of [
      [ids.otherPatient, ids.pedro],
      [ids.pedro, ids.otherPatient],
      [ids.pedro, ids.carmenB],
    ]) {
      const preview = await asB(
        api().get(
          `/api/v1/patient-duplicates/merge-preview?keptId=${keptId}&absorbedId=${absorbedId}`,
        ),
      ).expect(404);
      expect((preview.body as { message: string }).message).toBe(
        'Paciente no encontrado',
      );
      await asB(api().post('/api/v1/patient-duplicates/merge'))
        .send({ keptId, absorbedId })
        .expect(404);
    }
    // Y A tampoco alcanza al de B.
    await as(api().post('/api/v1/patient-duplicates/merge'))
      .send({ keptId: ids.pedro, absorbedId: ids.otherPatient })
      .expect(404);
    const after = await raw.patient.findMany({
      where: { tenantId: clinic.tenantId },
      select: { id: true, deletedAt: true, mergedIntoId: true, email: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
    expect(
      await raw.patient.count({
        where: { id: ids.otherPatient, deletedAt: null, mergedIntoId: null },
      }),
    ).toBe(1);
  });
});
