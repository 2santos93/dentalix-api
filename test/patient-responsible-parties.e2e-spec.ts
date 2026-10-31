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
import { REGIONAL_TOKYO_FIXTURE } from './support/location-fixtures';
import { DocumentTypeNamesReader } from '../src/modules/patients/domain/ports/document-type-names-repository.port';

// DX-203 en HTTP real: CRUD de responsables (paciente de la clínica o
// contacto sin ficha), «Responsable de» en la ficha del responsable, 404 de un
// paciente de otra clínica, 422 en español del segundo pagador, 409 del mismo
// paciente dos veces, los 4 roles y la auditoría sin el contenido.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Party {
  id: string;
  kind: 'PATIENT' | 'CONTACT';
  fullName: string;
  email: string | null;
  isPayer: boolean;
  receivesNotices: boolean;
  relationship: string;
  responsiblePatient: { id: string } | null;
}

interface Responsibles {
  patientId: string;
  minor: boolean;
  majorityAge: number;
  parties: Party[];
  responsibleFor: {
    id: string;
    patient: { id: string; firstName: string; lastName: string };
    isPayer: boolean;
  }[];
  noticeRecipient: { kind: string; email: string | null };
}

describe('Responsables de pago y avisos (e2e, DX-203)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let mother: string;
  let son: string;
  let daughter: string;
  let foreign: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const parties = (patientId: string) =>
    `/api/v1/patients/${patientId}/responsible-parties`;

  async function createPatient(
    target: Clinic,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/patients'),
      target.adminToken,
      target.host,
    )
      .send({ docType: 'NATIONAL_ID', sex: 'F', lastName: 'Ortiz', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function list(patientId: string, token = tokens.RECEPTION) {
    const res = await as(api().get(parties(patientId)), token).expect(200);
    return res.body as Responsibles;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx203-e2e');
    other = await registerClinic(app, 'dx203-e2e-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    mother = await createPatient(clinic, {
      firstName: 'Claudia',
      lastName: 'Navarro',
      docNumber: '52987654',
      email: 'claudia@example.com',
      birthDate: '1985-01-01',
    });
    son = await createPatient(clinic, {
      firstName: 'Tomás',
      docType: 'NATIONAL_ID',
      docNumber: '1011000001',
      sex: 'M',
      birthDate: '2016-04-10',
    });
    daughter = await createPatient(clinic, {
      firstName: 'Sofía',
      docType: 'NATIONAL_ID',
      docNumber: '1011000002',
      birthDate: '2015-02-11',
    });
    foreign = await createPatient(other, {
      firstName: 'Ajena',
      docNumber: '99000001',
      email: 'ajena@example.com',
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('sin responsables: lista vacía, menor según la mayoría de edad de la clínica', async () => {
    const view = await list(son);
    expect(view).toMatchObject({
      patientId: son,
      minor: true,
      majorityAge: 18,
      parties: [],
      responsibleFor: [],
      noticeRecipient: { kind: 'PATIENT', email: null },
    });
    expect(view).not.toHaveProperty('country');
  });

  it('recepción vincula a la madre (paciente) como pagadora y aparece en la ficha de ambos', async () => {
    const res = await as(api().post(parties(son)), tokens.RECEPTION)
      .send({
        responsiblePatientId: mother,
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      kind: 'PATIENT',
      fullName: 'Claudia Navarro',
      email: 'claudia@example.com',
      isPayer: true,
      receivesNotices: true,
      responsiblePatient: { id: mother },
    });
    expect(await list(son)).toMatchObject({
      parties: [{ kind: 'PATIENT', fullName: 'Claudia Navarro' }],
      noticeRecipient: { kind: 'RESPONSIBLE', email: 'claudia@example.com' },
    });
    expect((await list(mother)).responsibleFor).toEqual([
      expect.objectContaining({
        patient: { id: son, firstName: 'Tomás', lastName: 'Ortiz' },
        isPayer: true,
      }),
    ]);
  });

  it('un contacto nuevo (sin ficha), con los 4 roles', async () => {
    for (const role of [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      await as(api().get(parties(son)), tokens[role]).expect(200);
    }
    const res = await as(api().post(parties(son)), tokens.ASSISTANT)
      .send({
        fullName: ' Luis Ortiz ',
        docType: 'NATIONAL_ID',
        docNumber: '79345678',
        email: 'Luis@Example.com',
        phone: '+57 310 555 0101',
        relationship: 'FATHER',
        receivesNotices: false,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      kind: 'CONTACT',
      fullName: 'Luis Ortiz',
      email: 'luis@example.com',
      isPayer: false,
      receivesNotices: false,
      responsiblePatient: null,
    });
  });

  it('un segundo pagador principal: 422 en español', async () => {
    const res = await as(api().post(parties(son)), tokens.RECEPTION)
      .send({ fullName: 'Abuela', relationship: 'GRANDPARENT', isPayer: true })
      .expect(422);
    expect((res.body as { message: string }).message).toBe(
      'Claudia Navarro ya es el pagador principal de este paciente. Quítale esa marca antes de elegir a otro.',
    );
    const father = (await list(son)).parties.find(
      (p) => p.fullName === 'Luis Ortiz',
    ) as Party;
    await as(api().patch(`${parties(son)}/${father.id}`), tokens.RECEPTION)
      .send({ isPayer: true })
      .expect(422);
  });

  it('el mismo paciente dos veces: 409; él mismo: 400', async () => {
    await as(api().post(parties(son)), tokens.RECEPTION)
      .send({ responsiblePatientId: mother, relationship: 'MOTHER' })
      .expect(409);
    const self = await as(api().post(parties(son)), tokens.RECEPTION)
      .send({ responsiblePatientId: son, relationship: 'OTHER' })
      .expect(400);
    expect((self.body as { message: string }).message).toBe(
      'Un paciente no puede ser su propio responsable.',
    );
  });

  it('no se puede vincular a un paciente de otra clínica (404), ni tocar los de otra', async () => {
    const res = await as(api().post(parties(son)), tokens.RECEPTION)
      .send({ responsiblePatientId: foreign, relationship: 'MOTHER' })
      .expect(404);
    expect((res.body as { message: string }).message).toBe(
      'Paciente responsable no encontrado',
    );
    // Desde la otra clínica, el paciente de esta no existe.
    await as(api().get(parties(son)), other.adminToken, other.host).expect(404);
    await as(api().post(parties(son)), other.adminToken, other.host)
      .send({ fullName: 'Intrusa', relationship: 'OTHER' })
      .expect(404);
    const [party] = (await list(son)).parties;
    await as(
      api().patch(`${parties(son)}/${party.id}`),
      other.adminToken,
      other.host,
    )
      .send({ receivesNotices: false })
      .expect(404);
    await as(
      api().delete(`${parties(son)}/${party.id}`),
      other.adminToken,
      other.host,
    ).expect(404);
    expect((await list(son)).parties[0]).toMatchObject({ isPayer: true });
  });

  it('IDOR dentro de la clínica: el responsable de otro paciente es 404 por su :patientId', async () => {
    const [party] = (await list(son)).parties;
    const res = await as(
      api().patch(`${parties(daughter)}/${party.id}`),
      tokens.RECEPTION,
    )
      .send({ receivesNotices: false })
      .expect(404);
    expect((res.body as { message: string }).message).toBe(
      'Responsable no encontrado',
    );
    await as(
      api().delete(`${parties(daughter)}/${party.id}`),
      tokens.RECEPTION,
    ).expect(404);
    expect((await list(son)).parties[0]).toMatchObject({
      id: party.id,
      isPayer: true,
      receivesNotices: true,
    });
  });

  it('dos altas simultáneas como pagador principal: una entra y la otra 422 en español, nunca 500', async () => {
    for (let round = 0; round < 4; round += 1) {
      const patient = await createPatient(clinic, {
        firstName: `Simultáneo ${round}`,
        docNumber: `1011100${round}`,
      });
      const responses = await Promise.all(
        ['Abuela', 'Abuelo'].map((fullName) =>
          as(api().post(parties(patient)), tokens.RECEPTION).send({
            fullName,
            relationship: 'GRANDPARENT',
            isPayer: true,
          }),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
      const rejected = responses.find((r) => r.status === 422);
      expect((rejected?.body as { message: string }).message).toMatch(
        /pagador principal/,
      );
      const payers = await raw.patientResponsibleParty.count({
        where: { patientId: patient, isPayer: true, deletedAt: null },
      });
      expect(payers).toBe(1);
    }
  });

  it('dos ediciones simultáneas que marcan pagador: una entra y la otra 422, nunca 500', async () => {
    const patient = await createPatient(clinic, {
      firstName: 'Edición simultánea',
      docNumber: '10111999',
    });
    const ids: string[] = [];
    for (const fullName of ['Tía', 'Tío']) {
      const res = await as(api().post(parties(patient)), tokens.RECEPTION)
        .send({ fullName, relationship: 'OTHER' })
        .expect(201);
      ids.push((res.body as { id: string }).id);
    }
    const responses = await Promise.all(
      ids.map((id) =>
        as(api().patch(`${parties(patient)}/${id}`), tokens.RECEPTION).send({
          isPayer: true,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    const payers = await raw.patientResponsibleParty.count({
      where: { patientId: patient, isPayer: true, deletedAt: null },
    });
    expect(payers).toBe(1);
  });

  it('validación en español: forma, email, parentesco e ids', async () => {
    const both = await as(api().post(parties(daughter)), tokens.RECEPTION)
      .send({
        responsiblePatientId: mother,
        fullName: 'Claudia',
        relationship: 'MOTHER',
      })
      .expect(400);
    expect((both.body as { message: string }).message).toBe(
      'Elige un paciente de la clínica o escribe el nombre del contacto responsable, no las dos cosas.',
    );
    const bad = await as(api().post(parties(daughter)), tokens.RECEPTION)
      .send({ fullName: 'X', email: 'no-es-email', relationship: 'TIA' })
      .expect(400);
    expect((bad.body as { message: string[] }).message).toEqual(
      expect.arrayContaining([
        'El email del responsable no es válido.',
        expect.stringContaining('relationship debe ser'),
      ]),
    );
    await as(api().get(parties('no-es-uuid')), tokens.RECEPTION).expect(400);
  });

  it('editar y quitar; la auditoría guarda el motivo y los campos, no los datos', async () => {
    const created = await as(api().post(parties(daughter)), tokens.RECEPTION)
      .send({
        responsiblePatientId: mother,
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await as(api().patch(`${parties(daughter)}/${id}`), tokens.RECEPTION)
      .send({ receivesNotices: false })
      .expect(200);
    // Los datos de un paciente responsable se cambian en su ficha.
    await as(api().patch(`${parties(daughter)}/${id}`), tokens.RECEPTION)
      .send({ email: 'otra@example.com' })
      .expect(400);
    expect((await list(mother)).responsibleFor).toHaveLength(2);

    await as(
      api().delete(`${parties(daughter)}/${id}`),
      tokens.RECEPTION,
    ).expect(204);
    await as(
      api().delete(`${parties(daughter)}/${id}`),
      tokens.RECEPTION,
    ).expect(404);
    expect((await list(daughter)).parties).toEqual([]);
    expect((await list(mother)).responsibleFor).toHaveLength(1);

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, patientId: daughter },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, resourceType: true, metadata: true },
    });
    const reasons = events
      .map((e) => (e.metadata as { reason?: string }).reason)
      .filter(Boolean);
    expect(reasons).toEqual([
      'RESPONSIBLE_PARTY_ADDED',
      'RESPONSIBLE_PARTY_CHANGED',
      'RESPONSIBLE_PARTY_REMOVED',
    ]);
    const added = events.find(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'RESPONSIBLE_PARTY_ADDED',
    );
    expect(added).toMatchObject({ action: 'UPDATE', resourceType: 'PATIENT' });
    expect(
      (added?.metadata as { changedFields: string[] }).changedFields,
    ).toEqual(['isPayer', 'relationship', 'responsiblePatientId']);
    expect(JSON.stringify(events)).not.toContain('claudia');
  });

  it('rechaza null en los campos obligatorios del PATCH y conserva la edición parcial', async () => {
    const created = await as(api().post(parties(daughter)), tokens.RECEPTION)
      .send({
        fullName: 'Contacto PATCH null',
        relationship: 'OTHER',
        isPayer: true,
        receivesNotices: true,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const patchUrl = `${parties(daughter)}/${id}`;

    for (const [field, message] of [
      ['relationship', 'relationship debe ser'],
      ['isPayer', 'isPayer debe ser true o false.'],
      ['receivesNotices', 'receivesNotices debe ser true o false.'],
    ]) {
      const response = await as(api().patch(patchUrl), tokens.RECEPTION)
        .send({ [field]: null })
        .expect(400);
      expect((response.body as { message: string[] }).message).toEqual(
        expect.arrayContaining([expect.stringContaining(message)]),
      );
      const persisted = (await list(daughter)).parties.find(
        (party) => party.id === id,
      );
      expect(persisted).toMatchObject({
        relationship: 'OTHER',
        isPayer: true,
        receivesNotices: true,
      });
    }

    await as(api().patch(patchUrl), tokens.RECEPTION)
      .send({ receivesNotices: false })
      .expect(200);
    expect(
      (await list(daughter)).parties.find((party) => party.id === id),
    ).toMatchObject({
      relationship: 'OTHER',
      isPayer: true,
      receivesNotices: false,
    });
  });

  it('el acudiente antiguo ya no se escribe desde la ficha (DEPRECADO, solo lectura)', async () => {
    const res = await as(
      api().patch(`/api/v1/patients/${son}`),
      tokens.RECEPTION,
    )
      .send({ guardianName: 'Nuevo Acudiente', guardianDocNumber: '1' })
      .expect(200);
    expect(res.body).toMatchObject({
      guardianName: null,
      guardianDocNumber: null,
    });
  });

  it('responsible-parties minor follows the clinic value', async () => {
    // 17 años y medio hoy, sea cual sea la zona de la sede.
    const birth = new Date();
    birth.setUTCFullYear(birth.getUTCFullYear() - 17);
    birth.setUTCMonth(birth.getUTCMonth() - 6);
    const teen = await createPatient(clinic, {
      firstName: 'Irene',
      docType: 'NATIONAL_ID',
      docNumber: '1011000003',
      birthDate: birth.toISOString().slice(0, 10),
    });
    const settings = '/api/v1/patients/settings';
    try {
      expect(await list(teen)).toMatchObject({ minor: true, majorityAge: 18 });
      await as(api().put(settings), tokens.ADMIN)
        .send({ majorityAge: 16 })
        .expect(200);
      expect(await list(teen)).toMatchObject({
        minor: false,
        majorityAge: 16,
      });
    } finally {
      await as(api().put(settings), tokens.ADMIN)
        .send({ majorityAge: 18 })
        .expect(200);
    }
  });

  describe('estado de cuenta familiar del pagador', () => {
    let catalogItemId: string;
    let brother: string;
    let sister: string;
    let payer: string;

    async function planWith(patientId: string, price: number): Promise<string> {
      const plan = await as(
        api().post(`/api/v1/patients/${patientId}/treatment-plans`),
        clinic.adminToken,
      )
        .send({ currency: 'COP', notes: 'Nota clínica que no sale' })
        .expect(201);
      const planId = (plan.body as { id: string }).id;
      const item = await as(
        api().post(`/api/v1/treatment-plans/${planId}/items`),
        clinic.adminToken,
      )
        .send({ toothNumber: '11', catalogItemId, price })
        .expect(201);
      await as(
        api().patch(
          `/api/v1/treatment-plans/${planId}/items/${(item.body as { id: string }).id}`,
        ),
        clinic.adminToken,
      )
        .send({ status: 'ACCEPTED' })
        .expect(200);
      return planId;
    }

    async function pay(planId: string, amount: number): Promise<void> {
      await as(
        api().post(`/api/v1/treatment-plans/${planId}/payments`),
        tokens.RECEPTION,
      )
        .send({ amount, currency: 'COP', paidAt: '2026-01-15', method: 'CASH' })
        .expect(201);
    }

    interface Summary {
      currency: string;
      budgeted: number;
      paid: number;
      balance: number;
    }

    beforeAll(async () => {
      const catalog = await as(
        api().post('/api/v1/catalog/items'),
        clinic.adminToken,
      )
        .send({
          code: 'DX203-RESINA',
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 1,
        })
        .expect(201);
      catalogItemId = (catalog.body as { id: string }).id;
      payer = await createPatient(clinic, {
        firstName: 'Marta',
        lastName: 'Gil',
        docNumber: '41000001',
        email: 'marta@example.com',
        birthDate: '1980-05-05',
      });
      brother = await createPatient(clinic, {
        firstName: 'Iván',
        lastName: 'Gil',
        docType: 'NATIONAL_ID',
        docNumber: '1011000101',
        sex: 'M',
        birthDate: '2014-08-01',
      });
      sister = await createPatient(clinic, {
        firstName: 'Lucía',
        lastName: 'Gil',
        docType: 'NATIONAL_ID',
        docNumber: '1011000102',
        birthDate: '2017-03-03',
      });
      for (const child of [brother, sister]) {
        await as(api().post(parties(child)), tokens.RECEPTION)
          .send({
            responsiblePatientId: payer,
            relationship: 'MOTHER',
            isPayer: true,
          })
          .expect(201);
      }
      const b1 = await planWith(brother, 350000.35);
      await pay(b1, 100000.1);
      await pay(b1, 0.15);
      const s1 = await planWith(sister, 1200000.2);
      const s2 = await planWith(sister, 99999.99);
      await pay(s1, 450000.05);
      await pay(s2, 0.99);
      const own = await planWith(payer, 80000);
      await pay(own, 30000);
    });

    it('suma los saldos de sus pacientes con subtotal por paciente y cuadra al céntimo con los individuales', async () => {
      const res = await as(
        api().get(`/api/v1/patients/${payer}/family-account-statement`),
        tokens.RECEPTION,
      ).expect(200);
      const body = res.body as {
        payer: { id: string };
        members: {
          patient: { id: string; firstName: string };
          self: boolean;
          relationship: string | null;
          summary: Summary[];
        }[];
        totals: Summary[];
      };
      expect(body.payer.id).toBe(payer);
      expect(body.members.map((m) => [m.patient.firstName, m.self])).toEqual([
        ['Marta', true],
        ['Iván', false],
        ['Lucía', false],
      ]);

      // Cada subtotal = su estado de cuenta individual; el total, su suma.
      const cents = { budgeted: 0, paid: 0, balance: 0 };
      for (const member of body.members) {
        const single = await as(
          api().get(`/api/v1/patients/${member.patient.id}/account-statement`),
          tokens.RECEPTION,
        ).expect(200);
        const summary = (single.body as { summary: Summary[] }).summary;
        expect(
          member.summary.map(({ currency, budgeted, paid, balance }) => ({
            currency,
            budgeted,
            paid,
            balance,
          })),
        ).toEqual(
          summary.map(({ currency, budgeted, paid, balance }) => ({
            currency,
            budgeted,
            paid,
            balance,
          })),
        );
        for (const s of summary) {
          cents.budgeted += Math.round(s.budgeted * 100);
          cents.paid += Math.round(s.paid * 100);
          cents.balance += Math.round(s.balance * 100);
        }
      }
      expect(body.totals).toEqual([
        expect.objectContaining({
          currency: 'COP',
          budgeted: cents.budgeted / 100,
          paid: cents.paid / 100,
          balance: cents.balance / 100,
        }),
      ]);
      expect(body.totals[0]).toMatchObject({
        budgeted: 1730000.54,
        paid: 580001.29,
        balance: 1149999.25,
      });
      // Solo importes y nombres.
      const json = JSON.stringify(body);
      expect(json).not.toContain('1011000101');
      expect(json).not.toContain('Nota clínica');
    });

    it('el estado de cuenta individual de un menor sale a nombre de su responsable', async () => {
      const res = await as(
        api().get(`/api/v1/patients/${brother}/account-statement`),
        tokens.RECEPTION,
      ).expect(200);
      expect((res.body as { addressee: unknown }).addressee).toEqual({
        kind: 'RESPONSIBLE',
        name: 'Marta Gil',
        email: 'marta@example.com',
      });
    });

    // ISOLATION_COVERS: GET /patients/:patientId/family-account-statement
    it('roles y aislamiento: DENTIST 403; otra clínica 404', async () => {
      await as(
        api().get(`/api/v1/patients/${payer}/family-account-statement`),
        tokens.DENTIST,
      ).expect(403);
      await as(
        api().get(`/api/v1/patients/${payer}/family-account-statement`),
        other.adminToken,
        other.host,
      ).expect(404);
    });
  });

  // DX-327: el tipo genérico y el nombre libre de un contacto (R7, pre-flight
  // I1), el del paciente responsable y la fila anterior. La sede es
  // REGIONAL_TOKYO_FIXTURE.
  describe('DX-327: tipo de documento de los responsables', () => {
    interface DocParty {
      id: string;
      kind: string;
      docType: string | null;
      docTypeLabel: string | null;
      docTypeName: string | null;
      phone: string | null;
      responsiblePatient: {
        docType: string;
        docTypeLabel: string | null;
        docTypeName: string;
      } | null;
    }
    let tokyo: Clinic;
    let seq = 0;
    const at = (req: request.Test) =>
      req
        .set('X-Tenant-Host', tokyo.host)
        .set('Authorization', `Bearer ${tokyo.adminToken}`);
    const freshPatient = (body: Record<string, unknown> = {}) =>
      createPatient(tokyo, {
        firstName: `Documento ${++seq}`,
        docType: 'NATIONAL_ID',
        ...body,
      });
    const addContact = async (
      patientId: string,
      body: Record<string, unknown>,
    ) =>
      (
        await at(api().post(parties(patientId)))
          .send({ fullName: 'Contacto A', relationship: 'OTHER', ...body })
          .expect(201)
      ).body as DocParty;
    const partiesOf = async (patientId: string) =>
      (
        (await at(api().get(parties(patientId))).expect(200)).body as {
          parties: DocParty[];
        }
      ).parties;
    const sqlRow = async (id: string) => {
      const [row] = await raw.$queryRaw<
        {
          documentType: string | null;
          docType: string | null;
          docTypeLabel: string | null;
        }[]
      >`
        SELECT "documentType"::text AS "documentType", "docType"::text AS "docType", "docTypeLabel"
          FROM "patient_responsible_parties" WHERE "id" = ${id}::uuid`;
      return row;
    };
    // Como el diálogo de contacto (responsible-party-dialog.tsx): todos los
    // datos del contacto y los indicadores, con el tipo reenviado y sin
    // `docTypeLabel`.
    const dialogEdit = (patientId: string, partyId: string, docType: string) =>
      at(api().patch(`${parties(patientId)}/${partyId}`))
        .send({
          relationship: 'OTHER',
          isPayer: false,
          receivesNotices: true,
          fullName: 'Contacto A',
          docType,
          docNumber: 'RX-9001',
          email: null,
          phone: '+81 3 5555 0199',
        })
        .expect(200);

    beforeAll(async () => {
      tokyo = await registerClinic(app, 'dx327-rp', REGIONAL_TOKYO_FIXTURE);
    });

    it('a contact edit that resends its type keeps the label', async () => {
      const patientId = await freshPatient();
      const contact = await addContact(patientId, {
        docType: 'TAX_ID',
        docNumber: 'RX-9001',
        docTypeLabel: '  ID   local ',
      });
      expect(contact).toMatchObject({
        docType: 'TAX_ID',
        docTypeLabel: 'ID local',
        docTypeName: 'ID local',
      });
      // Fase 1: el alta escribe la pareja (TAX_ID no tiene código anterior).
      expect(await sqlRow(contact.id)).toEqual({
        documentType: 'TAX_ID',
        docType: 'OTHER',
        docTypeLabel: 'ID local',
      });

      await dialogEdit(patientId, contact.id, 'TAX_ID');
      expect((await partiesOf(patientId))[0]).toMatchObject({
        docType: 'TAX_ID',
        docTypeLabel: 'ID local',
        phone: '+81 3 5555 0199',
      });

      // Cambiar el tipo sin etiqueta la borra; quitar el tipo quita las dos.
      await dialogEdit(patientId, contact.id, 'PASSPORT');
      expect(await sqlRow(contact.id)).toEqual({
        documentType: 'PASSPORT',
        docType: 'PASSPORT',
        docTypeLabel: null,
      });
      await at(api().patch(`${parties(patientId)}/${contact.id}`))
        .send({ docTypeLabel: 'ID local' })
        .expect(200);
      await at(api().patch(`${parties(patientId)}/${contact.id}`))
        .send({ docType: null })
        .expect(200);
      expect(await sqlRow(contact.id)).toEqual({
        documentType: null,
        docType: null,
        docTypeLabel: null,
      });
      const res = await at(api().patch(`${parties(patientId)}/${contact.id}`))
        .send({ docTypeLabel: 'ID local' })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El nombre del documento necesita un tipo de documento.',
      );
    });

    it('legacy contact edit resending CC for a national ID keeps the label', async () => {
      const patientId = await freshPatient();
      const contact = await addContact(patientId, {
        docType: 'NATIONAL_ID',
        docTypeLabel: 'ID local',
      });
      await dialogEdit(patientId, contact.id, 'CC');
      expect((await partiesOf(patientId))[0]).toMatchObject({
        docType: 'NATIONAL_ID',
        docTypeLabel: 'ID local',
      });
    });

    it("a contact keeps its generic type and label; a patient responsible shows the patient's", async () => {
      const mom = await freshPatient({
        docType: 'RESIDENCE_PERMIT',
        docNumber: 'RX-9101',
        docTypeLabel: 'Permiso A',
      });
      const patientId = await freshPatient();
      await addContact(patientId, { docType: 'OTHER' });
      const linked = (
        await at(api().post(parties(patientId)))
          .send({ responsiblePatientId: mom, relationship: 'MOTHER' })
          .expect(201)
      ).body as DocParty;
      // Un `docTypeLabel: null` no toca nada en un paciente responsable; uno
      // con texto es 400 (sus datos se cambian en su ficha).
      await at(api().patch(`${parties(patientId)}/${linked.id}`))
        .send({ relationship: 'MOTHER', docTypeLabel: null })
        .expect(200);
      await at(api().patch(`${parties(patientId)}/${linked.id}`))
        .send({ docTypeLabel: 'ID local' })
        .expect(400);
      // Un paciente responsable no lleva datos de contacto.
      await at(api().post(parties(patientId)))
        .send({
          responsiblePatientId: mom,
          docTypeLabel: 'ID local',
          relationship: 'MOTHER',
        })
        .expect(400);

      const reader = app.get(DocumentTypeNamesReader, { strict: false });
      const get = jest.spyOn(reader, 'get');
      let listed: DocParty[];
      try {
        listed = await partiesOf(patientId);
        expect(get).toHaveBeenCalledTimes(1);
      } finally {
        get.mockRestore();
      }
      expect(listed).toEqual([
        expect.objectContaining({
          kind: 'CONTACT',
          docType: 'OTHER',
          docTypeLabel: null,
          docTypeName: 'Otro documento',
          responsiblePatient: null,
        }),
        expect.objectContaining({
          kind: 'PATIENT',
          docType: 'RESIDENCE_PERMIT',
          docTypeLabel: 'Permiso A',
          docTypeName: 'Permiso A',
          responsiblePatient: expect.objectContaining({
            docType: 'RESIDENCE_PERMIT',
            docTypeLabel: 'Permiso A',
            docTypeName: 'Permiso A',
          }) as unknown,
        }),
      ]);
      // Sin tipo: sin nombre visible.
      const typeless = await addContact(await freshPatient(), {});
      expect(typeless).toMatchObject({ docType: null, docTypeName: null });
    });

    it('legacy contact TI reads back as NATIONAL_ID with no label', async () => {
      const patientId = await freshPatient();
      await raw.$executeRaw`
        INSERT INTO "patient_responsible_parties"
          ("id","tenantId","patientId","fullName","docType","relationship","updatedAt")
        VALUES (gen_random_uuid(), ${tokyo.tenantId}::uuid, ${patientId}::uuid,
                'Contacto anterior', 'TI', 'OTHER', now())`;
      expect(await partiesOf(patientId)).toEqual([
        expect.objectContaining({
          kind: 'CONTACT',
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
          docTypeName: 'Documento nacional',
        }),
      ]);
      // La API nueva lo crea con el código anterior también.
      const created = await addContact(patientId, { docType: 'TI' });
      expect(created).toMatchObject({
        docType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });
  });
});
