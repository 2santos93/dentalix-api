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

// DX-105 en HTTP real: listas de precios por clínica y sede. Altas y edición
// solo ADMIN, lectura ADMIN/DENTIST/ASSISTANT; 409 de nombre, sede y moneda
// bloqueada; directorio paginado con el precio de la lista; PUT de precios en
// una transacción (500 filas, `null` quita, una prestación ajena da 400 sin
// escribir nada); retiro con convenio vivo y aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface ListBody {
  id: string;
  name: string;
  currency: string;
  locationId: string | null;
  active: boolean;
  itemCount: number;
}
interface RowBody {
  catalogItemId: string;
  code: string;
  labelEs: string;
  category: string | null;
  defaultPrice: number | null;
  price: number | null;
}
interface PageBody {
  items: RowBody[];
  total: number;
  page: number;
  pageSize: number;
}
interface IdBody {
  id: string;
}
interface MessageBody {
  message: string | string[];
}

describe('Listas de precios (e2e, DX-105)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let sedeNorte: string;
  let sedeSur: string;
  let catalogIds: string[];
  let otherCatalogId: string;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const admin = (req: request.Test) => as(req, tokens.ADMIN);

  async function createList(
    body: Record<string, unknown>,
    token = tokens.ADMIN,
  ): Promise<ListBody> {
    const res = await as(api().post('/api/v1/price-lists'), token)
      .send(body)
      .expect(201);
    return res.body as ListBody;
  }

  async function putItems(
    listId: string,
    items: { catalogItemId: string; price: number | null }[],
  ) {
    return admin(api().put(`/api/v1/price-lists/${listId}/items`)).send({
      items,
    });
  }

  async function names(query = '', token = tokens.ADMIN, c = clinic) {
    const res = await as(
      api().get(`/api/v1/price-lists${query}`),
      token,
      c.host,
    ).expect(200);
    return (res.body as ListBody[]).map((l) => l.name);
  }

  async function createCatalogItem(c: Clinic, code: string): Promise<string> {
    const res = await as(
      api().post('/api/v1/catalog/items'),
      c.adminToken,
      c.host,
    )
      .send({
        code,
        kind: 'PROCEDURE',
        labelEs: `Procedimiento ${code}`,
        color: '#0E7490',
        category: 'Operatoria',
        defaultPrice: 100000,
      })
      .expect(201);
    return (res.body as IdBody).id;
  }

  async function storedPrices(listId: string): Promise<Record<string, string>> {
    const rows = await raw.priceListItem.findMany({
      where: { priceListId: listId },
    });
    return Object.fromEntries(
      rows.map((r) => [r.catalogItemId, r.price.toFixed(2)]),
    );
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx105-listas');
    other = await registerClinic(app, 'dx105-listas-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }

    const sedes = await admin(api().get('/api/v1/locations')).expect(200);
    sedeNorte = (sedes.body as IdBody[])[0].id;
    const sur = await admin(api().post('/api/v1/locations'))
      .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Sur' }))
      .expect(201);
    sedeSur = (sur.body as IdBody).id;

    // Una clínica nace con el catálogo por defecto: se vacía para que los
    // totales del directorio sean exactos.
    await raw.dentalCatalogItem.deleteMany({
      where: { tenantId: { in: [clinic.tenantId, other.tenantId] } },
    });
    catalogIds = [];
    for (let i = 1; i <= 25; i++) {
      catalogIds.push(
        await createCatalogItem(clinic, `P-${String(i).padStart(2, '0')}`),
      );
    }
    otherCatalogId = await createCatalogItem(other, 'AJENO-1');
  }, 120_000);

  afterAll(async () => {
    await raw.$disconnect();
    await app.close();
  });

  describe('alta, roles y validación', () => {
    it('ADMIN crea una lista con nombre normalizado y moneda en mayúsculas', async () => {
      const list = await createList({
        name: '  Convenio   Surco ',
        currency: 'cop',
      });
      expect(list).toMatchObject({
        name: 'Convenio Surco',
        currency: 'COP',
        locationId: null,
        active: true,
        itemCount: 0,
      });
    });

    it('dentista, asistente y recepción no crean (403)', async () => {
      for (const role of [
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        await as(api().post('/api/v1/price-lists'), tokens[role])
          .send({ name: 'Nada', currency: 'COP' })
          .expect(403);
      }
    });

    it('leen ADMIN, dentista y asistente; recepción recibe 403', async () => {
      for (const role of [
        ClinicRole.ADMIN,
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
      ]) {
        expect(await names('', tokens[role])).toContain('Convenio Surco');
      }
      await as(api().get('/api/v1/price-lists'), tokens.RECEPTION).expect(403);
    });

    it('un nombre que solo cambia en mayúsculas o tildes da 409 en español', async () => {
      await createList({ name: 'Convenio Bolívar', currency: 'COP' });
      const res = await admin(api().post('/api/v1/price-lists'))
        .send({ name: ' CONVENIO  bolivar', currency: 'COP' })
        .expect(409);
      expect((res.body as MessageBody).message).toBe(
        'Ya existe una lista de precios con ese nombre.',
      );
    });

    it('moneda desconocida, nombre corto y cuerpo vacío dan 400', async () => {
      const unknown = await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'Moneda rara', currency: 'ZZZ' })
        .expect(400);
      expect((unknown.body as MessageBody).message).toBe('Moneda no válida.');
      await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'A', currency: 'COP' })
        .expect(400);
      await admin(api().post('/api/v1/price-lists')).send({}).expect(400);
    });

    it('una sede que no es de la clínica da 400 «Sede no encontrada.»', async () => {
      const otherSedes = await as(
        api().get('/api/v1/locations'),
        other.adminToken,
        other.host,
      ).expect(200);
      const ajena = (otherSedes.body as IdBody[])[0].id;
      const res = await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'Sede ajena', currency: 'COP', locationId: ajena })
        .expect(400);
      expect((res.body as MessageBody).message).toBe('Sede no encontrada.');
      expect(await names('?includeInactive=true')).not.toContain('Sede ajena');
    });
  });

  describe('sede y edición', () => {
    let norte: ListBody;

    it('una lista por sede: la segunda activa da 409', async () => {
      norte = await createList({
        name: 'Lista Norte',
        currency: 'COP',
        locationId: sedeNorte,
      });
      expect(norte.locationId).toBe(sedeNorte);
      const res = await admin(api().post('/api/v1/price-lists'))
        .send({ name: 'Otra Norte', currency: 'COP', locationId: sedeNorte })
        .expect(409);
      expect((res.body as MessageBody).message).toBe(
        'Esa sede ya tiene una lista de precios activa.',
      );
    });

    it('desactivar la lista libera la sede; reactivarla con otra activa da 409', async () => {
      await admin(api().patch(`/api/v1/price-lists/${norte.id}`))
        .send({ active: false })
        .expect(200);
      const second = await createList({
        name: 'Otra Norte',
        currency: 'COP',
        locationId: sedeNorte,
      });
      const res = await admin(api().patch(`/api/v1/price-lists/${norte.id}`))
        .send({ active: true })
        .expect(409);
      expect((res.body as MessageBody).message).toBe(
        'Esa sede ya tiene una lista de precios activa.',
      );
      // La desactivada sigue visible solo con includeInactive.
      expect(await names()).not.toContain('Lista Norte');
      expect(await names('?includeInactive=true')).toContain('Lista Norte');
      await admin(api().patch(`/api/v1/price-lists/${second.id}`))
        .send({ locationId: sedeSur })
        .expect(200);
    });

    it('PATCH renombra, mueve a la clínica entera (null) y valida los tipos', async () => {
      const res = await admin(api().patch(`/api/v1/price-lists/${norte.id}`))
        .send({ name: 'Lista Norte 2', locationId: null })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Lista Norte 2',
        locationId: null,
        active: false,
      });
      await admin(api().patch(`/api/v1/price-lists/${norte.id}`))
        .send({ active: null })
        .expect(400);
      await admin(api().patch(`/api/v1/price-lists/${norte.id}`))
        .send({ name: 'convenio SURCO' })
        .expect(409);
      await as(api().patch(`/api/v1/price-lists/${norte.id}`), tokens.DENTIST)
        .send({ name: 'Nada' })
        .expect(403);
    });

    it('404 en español para una lista que no existe', async () => {
      const res = await admin(
        api().patch('/api/v1/price-lists/11111111-1111-4111-8111-111111111111'),
      )
        .send({ name: 'Nada' })
        .expect(404);
      expect((res.body as MessageBody).message).toBe(
        'Lista de precios no encontrada.',
      );
      await admin(api().patch('/api/v1/price-lists/no-es-uuid'))
        .send({ name: 'Nada' })
        .expect(400);
    });
  });

  describe('precios', () => {
    let list: ListBody;

    beforeAll(async () => {
      list = await createList({ name: 'Lista de precios', currency: 'COP' });
    });

    it('el directorio lista solo procedimientos activos con price null, paginado de a 20', async () => {
      // Un diagnóstico y un procedimiento inactivo no aparecen.
      await admin(api().post('/api/v1/catalog/items'))
        .send({
          code: 'D-01',
          kind: 'DIAGNOSIS',
          labelEs: 'Caries',
          color: '#BE123C',
        })
        .expect(201);
      const inactive = await admin(api().post('/api/v1/catalog/items'))
        .send({
          code: 'P-INACTIVO',
          kind: 'PROCEDURE',
          labelEs: 'Inactivo',
          color: '#0E7490',
          active: false,
        })
        .expect(201);
      expect(inactive.body).toMatchObject({ active: false });

      const first = await admin(
        api().get(`/api/v1/price-lists/${list.id}/items`),
      ).expect(200);
      const page1 = first.body as PageBody;
      expect(page1).toMatchObject({ total: 25, page: 1, pageSize: 20 });
      expect(page1.items).toHaveLength(20);
      expect(page1.items[0]).toMatchObject({
        catalogItemId: catalogIds[0],
        code: 'P-01',
        category: 'Operatoria',
        defaultPrice: 100000,
        price: null,
      });
      const second = await admin(
        api().get(`/api/v1/price-lists/${list.id}/items?page=2`),
      ).expect(200);
      expect((second.body as PageBody).items).toHaveLength(5);
    });

    it('lo leen dentista y asistente; recepción recibe 403', async () => {
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await as(
          api().get(`/api/v1/price-lists/${list.id}/items`),
          tokens[role],
        ).expect(200);
      }
      await as(
        api().get(`/api/v1/price-lists/${list.id}/items`),
        tokens.RECEPTION,
      ).expect(403);
    });

    it('PUT fija 2 precios y quita uno con null; el directorio y el itemCount lo reflejan', async () => {
      const res = await putItems(list.id, [
        { catalogItemId: catalogIds[0], price: 150000.5 },
        { catalogItemId: catalogIds[1], price: 0 },
        { catalogItemId: catalogIds[2], price: 99 },
      ]).then((r) => r);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ upserted: 3, removed: 0 });

      const second = await putItems(list.id, [
        { catalogItemId: catalogIds[0], price: 175000 },
        { catalogItemId: catalogIds[2], price: null },
        { catalogItemId: catalogIds[3], price: null },
      ]);
      expect(second.status).toBe(200);
      // Un null sobre un procedimiento sin precio no cuenta como quitado.
      expect(second.body).toEqual({ upserted: 1, removed: 1 });

      expect(await storedPrices(list.id)).toEqual({
        [catalogIds[0]]: '175000.00',
        [catalogIds[1]]: '0.00',
      });

      const dir = await admin(
        api().get(`/api/v1/price-lists/${list.id}/items?query=P-0`),
      ).expect(200);
      const rows = (dir.body as PageBody).items;
      expect(rows.find((r) => r.code === 'P-01')?.price).toBe(175000);
      expect(rows.find((r) => r.code === 'P-02')?.price).toBe(0);
      expect(rows.find((r) => r.code === 'P-03')?.price).toBeNull();

      const lists = await admin(api().get('/api/v1/price-lists')).expect(200);
      expect(
        (lists.body as ListBody[]).find((l) => l.id === list.id)?.itemCount,
      ).toBe(2);
    });

    it('501 filas dan 400 por el tope del lote y no escriben nada', async () => {
      const big = await createList({ name: 'Lista grande', currency: 'COP' });
      const rows = Array.from({ length: 501 }, (_v, i) => ({
        catalogItemId: catalogIds[i % catalogIds.length],
        price: 1000 + i,
      }));
      const res = await putItems(big.id, rows);
      expect(res.status).toBe(400);
      expect(
        await raw.priceListItem.count({ where: { priceListId: big.id } }),
      ).toBe(0);
    });

    it('500 filas distintas (catálogo de 500 procedimientos) entran en un solo PUT', async () => {
      const lot = await createList({ name: 'Lista de 500', currency: 'COP' });
      const tenantId = clinic.tenantId;
      const ids = Array.from(
        { length: 500 },
        (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      await raw.dentalCatalogItem.createMany({
        data: ids.map((id, i) => ({
          id,
          tenantId,
          code: `BULK-${i}`,
          kind: 'PROCEDURE' as const,
          labelEs: `Masivo ${i}`,
          color: '#0E7490',
        })),
      });
      const res = await putItems(
        lot.id,
        ids.map((catalogItemId, i) => ({ catalogItemId, price: 100 + i })),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ upserted: 500, removed: 0 });
      expect(
        await raw.priceListItem.count({ where: { priceListId: lot.id } }),
      ).toBe(500);
    });

    it('una prestación de otra clínica da 400 y NO escribe ninguna fila del lote', async () => {
      const before = await storedPrices(list.id);
      const res = await putItems(list.id, [
        { catalogItemId: catalogIds[5], price: 5000 },
        { catalogItemId: otherCatalogId, price: 6000 },
      ]);
      expect(res.status).toBe(400);
      expect((res.body as MessageBody).message).toBe(
        'Hay prestaciones que no existen en el catálogo de esta clínica.',
      );
      expect(await storedPrices(list.id)).toEqual(before);
    });

    it('un procedimiento inactivo o que no es PROCEDURE da 400 y NO escribe nada', async () => {
      const before = await storedPrices(list.id);
      const inactive = await createCatalogItem(clinic, 'INACTIVO-1');
      await raw.dentalCatalogItem.update({
        where: { id: inactive },
        data: { active: false },
      });
      const product = await createCatalogItem(clinic, 'DIAG-1');
      await raw.dentalCatalogItem.update({
        where: { id: product },
        data: { kind: 'DIAGNOSIS' },
      });
      for (const bad of [inactive, product]) {
        const res = await putItems(list.id, [
          { catalogItemId: catalogIds[5], price: 5000 },
          { catalogItemId: bad, price: 6000 },
        ]);
        expect(res.status).toBe(400);
        expect((res.body as MessageBody).message).toBe(
          'Solo se pueden fijar precios de procedimientos activos.',
        );
      }
      expect(await storedPrices(list.id)).toEqual(before);
    });

    it('rechaza precio negativo, con 3 decimales, ausente y una prestación repetida', async () => {
      const before = await storedPrices(list.id);
      for (const price of [-1, 10.123]) {
        const res = await putItems(list.id, [
          { catalogItemId: catalogIds[6], price },
        ]);
        expect(res.status).toBe(400);
      }
      const missing = await admin(
        api().put(`/api/v1/price-lists/${list.id}/items`),
      )
        .send({ items: [{ catalogItemId: catalogIds[6] }] })
        .expect(400);
      expect(JSON.stringify(missing.body)).toContain('precio');
      const repeated = await putItems(list.id, [
        { catalogItemId: catalogIds[6], price: 1 },
        { catalogItemId: catalogIds[6], price: 2 },
      ]);
      expect(repeated.status).toBe(400);
      expect(await storedPrices(list.id)).toEqual(before);
    });

    it('solo ADMIN escribe precios (403 al dentista)', async () => {
      await as(
        api().put(`/api/v1/price-lists/${list.id}/items`),
        tokens.DENTIST,
      )
        .send({ items: [{ catalogItemId: catalogIds[0], price: 1 }] })
        .expect(403);
    });

    it('la moneda queda bloqueada con precios (409) y se puede cambiar sin ellos', async () => {
      const res = await admin(api().patch(`/api/v1/price-lists/${list.id}`))
        .send({ currency: 'USD' })
        .expect(409);
      expect((res.body as MessageBody).message).toBe(
        'La lista tiene precios; crea una lista nueva para otra moneda.',
      );
      // Repetir la moneda actual no estorba.
      await admin(api().patch(`/api/v1/price-lists/${list.id}`))
        .send({ currency: 'COP', name: 'Lista de precios 2' })
        .expect(200);

      const empty = await createList({ name: 'Sin precios', currency: 'COP' });
      const changed = await admin(
        api().patch(`/api/v1/price-lists/${empty.id}`),
      )
        .send({ currency: 'USD' })
        .expect(200);
      expect((changed.body as ListBody).currency).toBe('USD');
    });

    it('PUT y PATCH dejan auditoría con PRICE_LIST y sin importes', async () => {
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'PRICE_LIST' },
      });
      const replaced = events.filter(
        (e) =>
          (e.metadata as { reason?: string } | null)?.reason ===
          'PRICES_REPLACED',
      );
      expect(replaced.length).toBeGreaterThanOrEqual(2);
      expect(replaced[0]).toMatchObject({
        action: 'UPDATE',
        actorUserId: clinic.adminUserId,
        actorRole: 'ADMIN',
      });
      expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(
        '175000',
      );
      expect(events.some((e) => e.action === 'CREATE')).toBe(true);
    });
  });

  describe('retiro', () => {
    it('retira una lista sin convenios (204), libera el nombre y 404 la segunda vez', async () => {
      const gone = await createList({ name: 'Efímera', currency: 'COP' });
      await admin(api().delete(`/api/v1/price-lists/${gone.id}`)).expect(204);
      expect(await names('?includeInactive=true')).not.toContain('Efímera');
      await admin(api().delete(`/api/v1/price-lists/${gone.id}`)).expect(404);
      await createList({ name: 'Efímera', currency: 'COP' });
    });

    it('con un convenio vivo da 409 y no se retira; sin convenio vivo, sí', async () => {
      const used = await createList({ name: 'En uso', currency: 'COP' });
      const payer = await raw.payer.create({
        data: {
          tenantId: clinic.tenantId,
          name: 'Sanavida',
          type: 'PUBLIC_SYSTEM',
        },
      });
      const agreement = await raw.agreement.create({
        data: {
          tenantId: clinic.tenantId,
          name: 'Convenio con lista',
          payerId: payer.id,
          kind: 'PRICE_LIST',
          priceListId: used.id,
        },
      });
      const res = await admin(
        api().delete(`/api/v1/price-lists/${used.id}`),
      ).expect(409);
      expect((res.body as MessageBody).message).toBe(
        'Esta lista la usa un convenio; desactívala en lugar de retirarla.',
      );
      expect(await names()).toContain('En uso');

      // Desactivar sí se puede, y con el convenio retirado la lista se retira.
      await admin(api().patch(`/api/v1/price-lists/${used.id}`))
        .send({ active: false })
        .expect(200);
      await raw.agreement.update({
        where: { id: agreement.id },
        data: { deletedAt: new Date(), active: false },
      });
      await admin(api().delete(`/api/v1/price-lists/${used.id}`)).expect(204);
    });

    it('solo ADMIN retira (403 al dentista)', async () => {
      const list = await createList({ name: 'Intocable', currency: 'COP' });
      await as(
        api().delete(`/api/v1/price-lists/${list.id}`),
        tokens.DENTIST,
      ).expect(403);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('otra clínica no ve, edita, retira ni lee los precios de mis listas (404) y su listado va vacío', async () => {
      const mine = await createList({ name: 'Solo mía', currency: 'COP' });
      await putItems(mine.id, [{ catalogItemId: catalogIds[0], price: 1234 }]);
      const asOther = (req: request.Test) =>
        as(req, other.adminToken, other.host);

      await asOther(api().get(`/api/v1/price-lists/${mine.id}/items`)).expect(
        404,
      );
      await asOther(api().patch(`/api/v1/price-lists/${mine.id}`))
        .send({ name: 'Hackeada' })
        .expect(404);
      await asOther(api().put(`/api/v1/price-lists/${mine.id}/items`))
        .send({ items: [{ catalogItemId: otherCatalogId, price: 1 }] })
        .expect(404);
      await asOther(api().delete(`/api/v1/price-lists/${mine.id}`)).expect(404);

      expect(
        await names('?includeInactive=true', other.adminToken, other),
      ).toEqual([]);
      expect(await storedPrices(mine.id)).toEqual({
        [catalogIds[0]]: '1234.00',
      });
    });
  });
});
