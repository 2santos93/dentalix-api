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

// DX-105 en HTTP real: convenios por pagador. Altas y edición solo ADMIN,
// lectura los 4 roles; forma por `kind` (descuento o lista de precios), 400 con
// mensaje en español, categorías contra el catálogo con su ortografía, cambio
// de `kind` que vacía los campos del otro, 409 de nombre y de retiro con
// pacientes asignados, pagador con convenio que no se retira y aislamiento.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface AgreementBody {
  id: string;
  name: string;
  payer: { id: string; name: string; type: string };
  kind: 'PERCENT_DISCOUNT' | 'PRICE_LIST';
  percent: number | null;
  percentByCategory: Record<string, number> | null;
  priceList: { id: string; name: string; currency: string } | null;
  locationId: string | null;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  assignedCount: number;
}
interface IdBody {
  id: string;
}
interface MessageBody {
  message: string | string[];
}

describe('Convenios (e2e, DX-105)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let payerId: string;
  let otherPayerId: string;
  let listId: string;
  let sedeId: string;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const admin = (req: request.Test) => as(req, tokens.ADMIN);

  async function createAgreement(
    body: Record<string, unknown>,
    token = tokens.ADMIN,
  ): Promise<AgreementBody> {
    const res = await as(api().post('/api/v1/agreements'), token)
      .send({ payerId, ...body })
      .expect(201);
    return res.body as AgreementBody;
  }

  async function names(query = '', token = tokens.ADMIN, c = clinic) {
    const res = await as(
      api().get(`/api/v1/agreements${query}`),
      token,
      c.host,
    ).expect(200);
    return (res.body as AgreementBody[]).map((a) => a.name);
  }

  async function messageOf(req: request.Test, status: number) {
    const res = await req.expect(status);
    return (res.body as MessageBody).message;
  }

  async function createPayer(c: Clinic, name: string): Promise<string> {
    const res = await as(api().post('/api/v1/payers'), c.adminToken, c.host)
      .send({ name, type: 'EMPLOYER' })
      .expect(201);
    return (res.body as IdBody).id;
  }

  async function createPatient(): Promise<string> {
    const res = await admin(api().post('/api/v1/patients'))
      .send({
        firstName: 'Ana',
        lastName: 'Convenio',
        docType: 'CC',
        docNumber: '2020202020',
        sex: 'F',
      })
      .expect(201);
    return (res.body as IdBody).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx105-convenios');
    other = await registerClinic(app, 'dx105-convenios-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }

    // Catálogo propio de la clínica con dos categorías conocidas.
    await raw.dentalCatalogItem.deleteMany({
      where: { tenantId: { in: [clinic.tenantId, other.tenantId] } },
    });
    for (const [code, category] of [
      ['OP-1', 'Operatoria'],
      ['CX-1', 'Cirugía oral'],
    ]) {
      await admin(api().post('/api/v1/catalog/items'))
        .send({
          code,
          kind: 'PROCEDURE',
          labelEs: `Procedimiento ${code}`,
          color: '#0E7490',
          category,
        })
        .expect(201);
    }

    payerId = await createPayer(clinic, 'Sanitas');
    otherPayerId = await createPayer(other, 'Pagador de la otra');
    const list = await admin(api().post('/api/v1/price-lists'))
      .send({ name: 'Lista Sanitas', currency: 'COP' })
      .expect(201);
    listId = (list.body as IdBody).id;
    const sedes = await admin(api().get('/api/v1/locations')).expect(200);
    sedeId = (sedes.body as IdBody[])[0].id;
  }, 120_000);

  afterAll(async () => {
    await raw.$disconnect();
    await app.close();
  });

  describe('alta por kind', () => {
    it('descuento porcentual: nombre normalizado, pagador anidado y nace activo', async () => {
      const a = await createAgreement({
        name: '  Convenio   Sanitas ',
        kind: 'PERCENT_DISCOUNT',
        percent: 12.5,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
      });
      expect(a).toMatchObject({
        name: 'Convenio Sanitas',
        payer: { id: payerId, name: 'Sanitas' },
        kind: 'PERCENT_DISCOUNT',
        percent: 12.5,
        percentByCategory: null,
        priceList: null,
        locationId: null,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        active: true,
        assignedCount: 0,
      });
    });

    it('lista de precios: devuelve la lista con su moneda y ningún porcentaje', async () => {
      const a = await createAgreement({
        name: 'Por lista',
        kind: 'PRICE_LIST',
        priceListId: listId,
        locationId: sedeId,
      });
      expect(a).toMatchObject({
        kind: 'PRICE_LIST',
        percent: null,
        percentByCategory: null,
        priceList: { id: listId, name: 'Lista Sanitas', currency: 'COP' },
        locationId: sedeId,
      });
    });

    it('las categorías se guardan con la ortografía del catálogo', async () => {
      const a = await createAgreement({
        name: 'Con categorías',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
        percentByCategory: { OPERATORIA: 20, ' cirugia   oral ': 0 },
      });
      expect(a.percentByCategory).toEqual({
        Operatoria: 20,
        'Cirugía oral': 0,
      });
      const stored = await raw.agreement.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(stored.percentByCategory).toEqual({
        Operatoria: 20,
        'Cirugía oral': 0,
      });
      expect(stored.percent?.toFixed(2)).toBe('5.00');
    });
  });

  describe('validación (400 en español)', () => {
    const post = (body: Record<string, unknown>) =>
      admin(api().post('/api/v1/agreements')).send({ payerId, ...body });

    it('porcentaje, lista y combinaciones por kind', async () => {
      expect(
        await messageOf(
          post({ name: 'Sin porcentaje', kind: 'PERCENT_DISCOUNT' }),
          400,
        ),
      ).toBe('Indica el porcentaje del convenio.');
      expect(
        await messageOf(post({ name: 'Sin lista', kind: 'PRICE_LIST' }), 400),
      ).toBe('Indica la lista de precios del convenio.');
      expect(
        await messageOf(
          post({
            name: 'Descuento con lista',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            priceListId: listId,
          }),
          400,
        ),
      ).toBe('Un convenio con descuento porcentual no lleva lista de precios.');
      expect(
        await messageOf(
          post({
            name: 'Lista con porcentaje',
            kind: 'PRICE_LIST',
            priceListId: listId,
            percent: 5,
          }),
          400,
        ),
      ).toBe('Un convenio con lista de precios no lleva porcentaje.');
    });

    it('porcentaje fuera de 0–100 o con más de 2 decimales', async () => {
      for (const percent of [-1, 100.5, 10.123]) {
        expect(
          await messageOf(
            post({ name: 'Rango', kind: 'PERCENT_DISCOUNT', percent }),
            400,
          ),
        ).toContain('El porcentaje debe estar entre 0 y 100.');
      }
    });

    it('categoría que no existe en el catálogo y mapa mal formado', async () => {
      expect(
        await messageOf(
          post({
            name: 'Mala categoría',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            percentByCategory: { Estética: 10 },
          }),
          400,
        ),
      ).toBe('La categoría «Estética» no existe en el catálogo.');
      expect(
        await messageOf(
          post({
            name: 'Valor en rango',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            percentByCategory: { Operatoria: 150 },
          }),
          400,
        ),
      ).toEqual([
        'Los porcentajes por categoría deben ser un objeto de hasta 50 categorías, con porcentajes entre 0 y 100 y hasta 2 decimales.',
      ]);
      expect(
        await messageOf(
          post({
            name: 'Repetida',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            percentByCategory: { Operatoria: 10, operatoria: 20 },
          }),
          400,
        ),
      ).toBe('La categoría «Operatoria» está repetida.');
    });

    it('nombre, fechas, tipo y cuerpo vacío', async () => {
      await post({ name: 'A', kind: 'PERCENT_DISCOUNT', percent: 5 }).expect(
        400,
      );
      expect(
        await messageOf(
          post({
            name: 'Fechas',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            validFrom: '2026-05-01',
            validTo: '2026-04-01',
          }),
          400,
        ),
      ).toBe('La fecha de fin no puede ser anterior a la de inicio.');
      expect(
        await messageOf(
          post({
            name: 'Fecha mala',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            validFrom: '2026-02-30',
          }),
          400,
        ),
      ).toBe('La fecha debe tener el formato AAAA-MM-DD.');
      await post({ name: 'Tipo', kind: 'OTRO', percent: 5 }).expect(400);
      await admin(api().post('/api/v1/agreements')).send({}).expect(400);
    });

    it('pagador inexistente, de otra clínica o desactivado; lista y sede inválidas', async () => {
      expect(
        await messageOf(
          post({
            name: 'Pagador ajeno',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            payerId: otherPayerId,
          }),
          400,
        ),
      ).toBe('Pagador no encontrado.');

      const off = await createPayer(clinic, 'Pagador apagado');
      await admin(api().patch(`/api/v1/payers/${off}`))
        .send({ active: false })
        .expect(200);
      expect(
        await messageOf(
          post({
            name: 'Pagador apagado',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            payerId: off,
          }),
          400,
        ),
      ).toBe('Ese pagador está desactivado.');

      expect(
        await messageOf(
          post({
            name: 'Lista fantasma',
            kind: 'PRICE_LIST',
            priceListId: '11111111-1111-4111-8111-111111111111',
          }),
          400,
        ),
      ).toBe('Lista de precios no encontrada.');

      const offList = await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'Lista apagada', currency: 'COP' })
        .expect(201);
      await admin(
        api().patch(`/api/v1/price-lists/${(offList.body as IdBody).id}`),
      )
        .send({ active: false })
        .expect(200);
      expect(
        await messageOf(
          post({
            name: 'Lista apagada',
            kind: 'PRICE_LIST',
            priceListId: (offList.body as IdBody).id,
          }),
          400,
        ),
      ).toBe('Esa lista de precios está desactivada.');

      const otherSedes = await as(
        api().get('/api/v1/locations'),
        other.adminToken,
        other.host,
      ).expect(200);
      expect(
        await messageOf(
          post({
            name: 'Sede ajena',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            locationId: (otherSedes.body as IdBody[])[0].id,
          }),
          400,
        ),
      ).toBe('Sede no encontrada.');
      expect(await names('?includeInactive=true')).not.toContain('Sede ajena');
    });
  });

  describe('roles', () => {
    it('dentista, asistente y recepción no escriben (403)', async () => {
      const a = await createAgreement({
        name: 'Para roles',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      for (const role of [
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        await as(api().post('/api/v1/agreements'), tokens[role])
          .send({
            name: 'Nada',
            payerId,
            kind: 'PERCENT_DISCOUNT',
            percent: 1,
          })
          .expect(403);
        await as(api().patch(`/api/v1/agreements/${a.id}`), tokens[role])
          .send({ name: 'Nada' })
          .expect(403);
        await as(api().delete(`/api/v1/agreements/${a.id}`), tokens[role])
          .send()
          .expect(403);
      }
    });

    it('leen los cuatro roles', async () => {
      for (const role of Object.values(ClinicRole)) {
        if (!tokens[role]) continue;
        expect(await names('', tokens[role])).toContain('Para roles');
      }
    });
  });

  describe('nombre único', () => {
    it('un nombre que solo cambia en mayúsculas o tildes da 409 en español', async () => {
      await createAgreement({
        name: 'Convenio Bolívar',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      expect(
        await messageOf(
          admin(api().post('/api/v1/agreements')).send({
            payerId,
            name: ' CONVENIO  bolivar',
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
          }),
          409,
        ),
      ).toBe('Ya existe un convenio con ese nombre.');
    });

    it('renombrar hacia el de otro da 409; tras retirar, el nombre se reutiliza', async () => {
      const a = await createAgreement({
        name: 'Renombrable',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ name: 'convenio bolivar' })
        .expect(409);
      await admin(api().delete(`/api/v1/agreements/${a.id}`)).expect(204);
      await createAgreement({
        name: 'Renombrable',
        kind: 'PERCENT_DISCOUNT',
        percent: 7,
      });
    });
  });

  describe('edición', () => {
    it('PATCH cambia campos sueltos y deja el resto', async () => {
      const a = await createAgreement({
        name: 'Editable',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
        validFrom: '2026-03-01',
        validTo: '2026-06-01',
      });
      const res = await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ name: 'Editable 2', percent: 15, active: false })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Editable 2',
        percent: 15,
        active: false,
        validFrom: '2026-03-01',
        validTo: '2026-06-01',
      });
      // Desactivado: sale del listado por defecto y vuelve con includeInactive.
      expect(await names()).not.toContain('Editable 2');
      expect(await names('?includeInactive=true')).toContain('Editable 2');
    });

    it('null borra la vigencia y las categorías; el rango se valida contra lo guardado', async () => {
      const a = await createAgreement({
        name: 'Vigencia',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
        percentByCategory: { Operatoria: 5 },
        validFrom: '2026-03-01',
        validTo: '2026-06-01',
      });
      expect(
        await messageOf(
          admin(api().patch(`/api/v1/agreements/${a.id}`)).send({
            validTo: '2026-02-01',
          }),
          400,
        ),
      ).toBe('La fecha de fin no puede ser anterior a la de inicio.');
      const res = await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ validFrom: null, validTo: null, percentByCategory: null })
        .expect(200);
      expect(res.body).toMatchObject({
        validFrom: null,
        validTo: null,
        percentByCategory: null,
        percent: 10,
      });
    });

    it('cambiar de kind vacía los campos del otro y pide los del nuevo', async () => {
      const a = await createAgreement({
        name: 'Cambia de tipo',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
        percentByCategory: { Operatoria: 5 },
      });
      expect(
        await messageOf(
          admin(api().patch(`/api/v1/agreements/${a.id}`)).send({
            kind: 'PRICE_LIST',
          }),
          400,
        ),
      ).toBe('Indica la lista de precios del convenio.');

      const toList = await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ kind: 'PRICE_LIST', priceListId: listId })
        .expect(200);
      expect(toList.body).toMatchObject({
        kind: 'PRICE_LIST',
        percent: null,
        percentByCategory: null,
        priceList: { id: listId },
      });
      const stored = await raw.agreement.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(stored.percent).toBeNull();
      expect(stored.percentByCategory).toBeNull();

      expect(
        await messageOf(
          admin(api().patch(`/api/v1/agreements/${a.id}`)).send({
            kind: 'PERCENT_DISCOUNT',
          }),
          400,
        ),
      ).toBe('Indica el porcentaje del convenio.');
      const back = await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ kind: 'PERCENT_DISCOUNT', percent: 20 })
        .expect(200);
      expect(back.body).toMatchObject({
        kind: 'PERCENT_DISCOUNT',
        percent: 20,
        priceList: null,
      });
    });

    it('name, payerId, kind o active en null dan 400, nunca 500', async () => {
      const a = await createAgreement({
        name: 'Nulos',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      });
      for (const field of ['name', 'payerId', 'kind', 'active']) {
        await admin(api().patch(`/api/v1/agreements/${a.id}`))
          .send({ [field]: null })
          .expect(400);
      }
    });

    it('cambiar de pagador exige uno vivo y activo; la lista, una activa', async () => {
      const a = await createAgreement({
        name: 'Cambia de pagador',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      });
      expect(
        await messageOf(
          admin(api().patch(`/api/v1/agreements/${a.id}`)).send({
            payerId: otherPayerId,
          }),
          400,
        ),
      ).toBe('Pagador no encontrado.');
      const second = await createPayer(clinic, 'Segundo pagador');
      const res = await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ payerId: second })
        .expect(200);
      // SEC-047: el pagador viaja con su tipo.
      expect((res.body as AgreementBody).payer).toEqual({
        id: second,
        name: 'Segundo pagador',
        type: 'EMPLOYER',
      });
    });

    it('un convenio cuyo pagador se desactivó después se sigue pudiendo renombrar', async () => {
      const payer = await createPayer(clinic, 'Pagador que se apaga');
      const a = await createAgreement({
        name: 'Pagador que se apaga',
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
        payerId: payer,
      });
      await admin(api().patch(`/api/v1/payers/${payer}`))
        .send({ active: false })
        .expect(200);
      await admin(api().patch(`/api/v1/agreements/${a.id}`))
        .send({ name: 'Renombrado igual' })
        .expect(200);
    });

    it('404 en español para un convenio que no existe', async () => {
      expect(
        await messageOf(
          admin(
            api().patch(
              '/api/v1/agreements/11111111-1111-4111-8111-111111111111',
            ),
          ).send({ name: 'Nada' }),
          404,
        ),
      ).toBe('Convenio no encontrado.');
      await admin(api().patch('/api/v1/agreements/no-es-uuid'))
        .send({ name: 'Nada' })
        .expect(400);
    });
  });

  describe('retiro', () => {
    it('sin pacientes asignados da 204 y deja de listarse', async () => {
      const a = await createAgreement({
        name: 'Para retirar',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      await admin(api().delete(`/api/v1/agreements/${a.id}`)).expect(204);
      expect(await names('?includeInactive=true')).not.toContain(
        'Para retirar',
      );
      const stored = await raw.agreement.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(stored.deletedAt).not.toBeNull();
      expect(stored.active).toBe(false);
      await admin(api().delete(`/api/v1/agreements/${a.id}`)).expect(404);
    });

    it('con una asignación viva da 409 y cuenta en assignedCount; la retirada no cuenta', async () => {
      const a = await createAgreement({
        name: 'En uso',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      const patientId = await createPatient();
      await raw.$executeRaw`
        INSERT INTO "patient_agreements" ("id", "tenantId", "patientId", "agreementId", "updatedAt", "deletedAt")
        VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${patientId}::uuid, ${a.id}::uuid, now(), now())`;
      await raw.$executeRaw`
        INSERT INTO "patient_agreements" ("id", "tenantId", "patientId", "agreementId", "updatedAt")
        VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${patientId}::uuid, ${a.id}::uuid, now())`;

      const listed = await admin(api().get('/api/v1/agreements')).expect(200);
      expect(
        (listed.body as AgreementBody[]).find((x) => x.id === a.id)
          ?.assignedCount,
      ).toBe(1);
      expect(
        await messageOf(admin(api().delete(`/api/v1/agreements/${a.id}`)), 409),
      ).toBe(
        'Este convenio tiene pacientes asignados; desactívalo en lugar de retirarlo.',
      );
      expect(await names()).toContain('En uso');
    });

    it('un pagador con un convenio vivo no se retira (409) y sí cuando el convenio se retira', async () => {
      const payer = await createPayer(clinic, 'Pagador con convenio');
      const a = await createAgreement({
        name: 'Convenio del pagador',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
        payerId: payer,
      });
      await admin(api().delete(`/api/v1/payers/${payer}`)).expect(409);
      await admin(api().delete(`/api/v1/agreements/${a.id}`)).expect(204);
      await admin(api().delete(`/api/v1/payers/${payer}`)).expect(204);
    });

    it('una lista con un convenio vivo no se retira (409)', async () => {
      const list = await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'Lista con convenio', currency: 'COP' })
        .expect(201);
      const id = (list.body as IdBody).id;
      await createAgreement({
        name: 'Convenio de la lista',
        kind: 'PRICE_LIST',
        priceListId: id,
      });
      await admin(api().delete(`/api/v1/price-lists/${id}`)).expect(409);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('B no ve, edita ni retira los convenios de A, y el mismo nombre no choca', async () => {
      const a = await createAgreement({
        name: 'Solo de A',
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
      });
      expect(
        await names('?includeInactive=true', other.adminToken, other),
      ).toEqual([]);
      await as(
        api().patch(`/api/v1/agreements/${a.id}`),
        other.adminToken,
        other.host,
      )
        .send({ name: 'Hackeado' })
        .expect(404);
      await as(
        api().delete(`/api/v1/agreements/${a.id}`),
        other.adminToken,
        other.host,
      ).expect(404);
      await as(api().post('/api/v1/agreements'), other.adminToken, other.host)
        .send({
          name: 'Solo de A',
          payerId: otherPayerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        })
        .expect(201);
      const stored = await raw.agreement.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(stored.name).toBe('Solo de A');
    });
  });
});
