import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  DocType,
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

// DX-204 en HTTP real: tope de descuento por rol, motivo obligatorio por
// encima del umbral, «Descuento %» en bloque con redondeo por moneda, planes
// aceptados que no se vuelven a descontar, política editable solo por ADMIN e
// informe de descuentos (cuadre, filtros, CSV y aislamiento por clínica).
// `raw` (DIRECT_URL, owner) solo fecha un descuento en el pasado, lee la
// auditoría y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY = 24 * 60 * 60 * 1000;
let requestSeq = 0;
/** X-Request-Id propio para encontrar el evento de auditoría de la petición. */
const nextRequestId = () => `dx204-e2e-${++requestSeq}-${Date.now()}`;
/** Día civil de Bogotá (UTC−5 fijo) `offset` días desde hoy. */
const bogotaDay = (offset = 0) =>
  new Date(Date.now() - 5 * 60 * 60 * 1000 + offset * DAY)
    .toISOString()
    .slice(0, 10);

interface Item {
  id: string;
  catalogPrice: number | null;
  price: number;
  discount: number;
  discountReason: string | null;
  discountReasonNote: string | null;
  discountById: string | null;
  discountAt: string | null;
  discountLocationId: string | null;
}

interface Report {
  totals: {
    currency: string;
    items: number;
    gross: number;
    discount: number;
    percentOfGross: number;
  }[];
  items: {
    itemId: string;
    patientName: string;
    catalogPrice: number | null;
    price: number;
    priceReduction: number;
    itemDiscount: number;
    discount: number;
    percent: number;
    reason: string | null;
    discountById: string | null;
    discountByName: string | null;
    locationId: string | null;
  }[];
  total: number;
}

type Role = 'ADMIN' | 'DENTIST' | 'ASSISTANT';

describe('Descuentos: tope por rol, motivo e informe (e2e, DX-204)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  const tokens = {} as Record<Role, string>;
  let dentistId: string;
  let patientA: string;
  let catalogA: string;
  let crownA: string;
  let mainLocationA: string;
  let northLocationA: string;

  const as = (clinic: Clinic, token = clinic.adminToken, location?: string) => {
    const call =
      (verb: 'get' | 'post' | 'patch' | 'put' | 'delete') =>
      (path: string, body?: object) => {
        const req = request(app.getHttpServer())
          [verb](`/api/v1${path}`)
          .set('X-Tenant-Host', clinic.host)
          .set('Authorization', `Bearer ${token}`);
        if (location) req.set('X-Location-Id', location);
        return body === undefined ? req : req.send(body);
      };
    return {
      get: call('get'),
      post: call('post'),
      patch: call('patch'),
      put: call('put'),
      delete: call('delete'),
    };
  };

  async function newPlan(currency = 'COP'): Promise<string> {
    const res = await as(clinicA)
      .post(`/patients/${patientA}/treatment-plans`, { currency })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addItem(
    planId: string,
    price: number,
    extra: object = {},
    token = tokens.ADMIN,
  ): Promise<Item> {
    const res = await as(clinicA, token)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '36',
        catalogItemId: catalogA,
        price,
        ...extra,
      })
      .expect(201);
    return res.body as Item;
  }

  async function planItems(planId: string): Promise<Item[]> {
    const res = await as(clinicA).get(`/treatment-plans/${planId}`).expect(200);
    return (res.body as { items: Item[] }).items;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'descuentos-a');
    clinicB = await registerClinic(app, 'descuentos-b');
    tokens.ADMIN = clinicA.adminToken;
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistId = dentist.userId;
    tokens.DENTIST = await loginAs(app, clinicA.host, dentist.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    tokens.ASSISTANT = await loginAs(app, clinicA.host, assistant.email);

    // Sin precio de catálogo (ítem libre): estos casos de DX-204 miden solo el
    // campo `discount`. La rebaja frente al catálogo (SEC-041) usa `crownA`.
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DESC-COR',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona',
        color: '#2A2B3C',
      })
      .expect(201);
    catalogA = (catalog.body as { id: string }).id;
    const crown = await as(clinicA)
      .post('/catalog/items', {
        code: 'DESC-COR-CAT',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona de catálogo',
        color: '#2A2B3C',
        defaultPrice: 1000000,
      })
      .expect(201);
    crownA = (crown.body as { id: string }).id;
    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Descuento',
        docType: DocType.CC,
        docNumber: '9001',
        sex: Sex.F,
      })
      .expect(201);
    patientA = (patient.body as { id: string }).id;
    const locations = await as(clinicA).get('/locations').expect(200);
    mainLocationA = (locations.body as { id: string }[])[0].id;
    const north = await as(clinicA)
      .post('/locations', { name: 'Sede Norte' })
      .expect(201);
    northLocationA = (north.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('tope por rol (servidor)', () => {
    it('un DENTIST no puede guardar un 15 % al crear: 403 en español y no se crea', async () => {
      const planId = await newPlan();
      const res = await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000000,
          discount: 150000,
          discountReason: 'LOYALTY',
        })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Tu rol permite hasta un 10 % de descuento por ítem.',
      );
      expect(await planItems(planId)).toHaveLength(0);
    });

    it('un DENTIST no puede subir un ítem a un 15 %: el ítem no cambia', async () => {
      const planId = await newPlan();
      const item = await addItem(planId, 1000000, {}, tokens.DENTIST);
      const res = await as(clinicA, tokens.DENTIST)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          discount: 150000,
          discountReason: 'LOYALTY',
        })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Tu rol permite hasta un 10 % de descuento por ítem.',
      );
      const [after] = await planItems(planId);
      expect(after).toMatchObject({ discount: 0, discountById: null });
    });

    it('la asistente (0 %) no descuenta; el DENTIST sí hasta su 10 %, a su nombre y en su sede', async () => {
      const planId = await newPlan();
      await as(clinicA, tokens.ASSISTANT)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000,
          discount: 1,
        })
        .expect(403);
      const res = await as(clinicA, tokens.DENTIST, northLocationA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000000,
          discount: 100000,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        discount: 100000,
        discountReason: null,
        discountById: dentistId,
        discountLocationId: northLocationA,
      });
      expect((res.body as Item).discountAt).not.toBeNull();
    });
  });

  describe('motivo obligatorio por encima del umbral', () => {
    it('422 si falta; con motivo y nota se guarda; «Otro» sin nota, 422', async () => {
      const planId = await newPlan();
      const missing = await as(clinicA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000000,
          discount: 200000,
        })
        .expect(422);
      expect((missing.body as { message: string }).message).toBe(
        'El descuento supera el 10 %: indica el motivo.',
      );
      await as(clinicA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000000,
          discount: 200000,
          discountReason: 'OTHER',
        })
        .expect(422);
      const item = await addItem(planId, 1000000, {
        discount: 200000,
        discountReason: 'OTHER',
        discountReasonNote: 'Convenio con la empresa',
      });
      expect(item).toMatchObject({
        discountReason: 'OTHER',
        discountReasonNote: 'Convenio con la empresa',
        discountById: clinicA.adminUserId,
        discountLocationId: mainLocationA,
      });
      // Un motivo fuera del catálogo: 400 de validación.
      await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          discountReason: 'INVENTADO',
        })
        .expect(400);
    });

    it('el cambio queda en la auditoría como TREATMENT_PLAN_ITEM, con los campos y sin la nota ni importes', async () => {
      const planId = await newPlan();
      const item = await addItem(planId, 1000000);
      const requestId = nextRequestId();
      await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          discount: 300000,
          discountReason: 'FINANCIAL_HARDSHIP',
          discountReasonNote: 'Paciente en paro',
        })
        .set('X-Request-Id', requestId)
        .expect(200);
      const [event] = await raw.auditEvent.findMany({ where: { requestId } });
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceType: 'TREATMENT_PLAN_ITEM',
        resourceId: item.id,
        patientId: patientA,
      });
      expect(event.metadata).toMatchObject({
        changedFields: ['discount', 'discountReason', 'discountReasonNote'],
      });
      const text = JSON.stringify(event.metadata);
      expect(text).not.toContain('paro');
      expect(text).not.toContain('300000');
    });
  });

  describe('«Descuento %» sobre varios ítems', () => {
    it('COP sin decimales, tope ítem a ítem, un solo evento de auditoría', async () => {
      const planId = await newPlan('COP');
      const items = [
        await addItem(planId, 85000),
        await addItem(planId, 123457),
        await addItem(planId, 1005),
      ];
      const requestId = nextRequestId();
      const res = await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: items.map((i) => i.id),
          percent: 10,
        })
        .set('X-Request-Id', requestId)
        .expect(200);
      const byId = new Map((res.body as Item[]).map((i) => [i.id, i]));
      // 8500; 12345,7 → 12346 y 100,5 → 101 superarían el 10 % del DENTIST:
      // bajan a 12345 y 100.
      expect(items.map((i) => byId.get(i.id)!.discount)).toEqual([
        8500, 12345, 100,
      ]);
      expect(
        [...byId.values()].every((i) => i.discountById === dentistId),
      ).toBe(true);
      const events = await raw.auditEvent.findMany({ where: { requestId } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'TREATMENT_PLAN_ITEM',
        patientId: patientA,
      });
      expect(events[0].metadata).toMatchObject({ reason: 'BULK_DISCOUNT' });
    });

    it('EUR a céntimos', async () => {
      const planId = await newPlan('EUR');
      const items = [
        await addItem(planId, 85.55),
        await addItem(planId, 123.45),
        await addItem(planId, 0.99),
      ];
      const res = await as(clinicA)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: items.map((i) => i.id),
          percent: 7.5,
        })
        .expect(200);
      const byId = new Map((res.body as Item[]).map((i) => [i.id, i]));
      expect(items.map((i) => byId.get(i.id)!.discount)).toEqual([
        6.42, 9.26, 0.07,
      ]);
    });

    it('por encima del tope del rol: 403 y nada cambia; sin motivo por encima del umbral: 422', async () => {
      const planId = await newPlan();
      const items = [await addItem(planId, 1000), await addItem(planId, 2000)];
      const ids = items.map((i) => i.id);
      await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: ids,
          percent: 15,
          discountReason: 'LOYALTY',
        })
        .expect(403);
      await as(clinicA)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: ids,
          percent: 15,
        })
        .expect(422);
      expect((await planItems(planId)).map((i) => i.discount)).toEqual([0, 0]);
    });

    it('un ítem de otro plan: 404 y nada cambia', async () => {
      const planId = await newPlan();
      const other = await newPlan();
      const mine = await addItem(planId, 1000);
      const foreign = await addItem(other, 1000);
      await as(clinicA)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: [mine.id, foreign.id],
          percent: 5,
        })
        .expect(404);
      expect((await planItems(planId))[0].discount).toBe(0);
    });
  });

  describe('presupuesto aceptado (congelado)', () => {
    it('no se vuelve a descontar: ni ítem a ítem ni en bloque (409)', async () => {
      const planId = await newPlan();
      const item = await addItem(planId, 1000000, { discount: 50000 });
      await as(clinicA)
        .patch(`/treatment-plans/${planId}`, { status: 'ACCEPTED' })
        .expect(200);
      const res = await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          discount: 80000,
        })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'El presupuesto ya está aceptado: sus descuentos no se pueden cambiar.',
      );
      await as(clinicA)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: [item.id],
          percent: 5,
        })
        .expect(409);
      expect((await planItems(planId))[0].discount).toBe(50000);
    });
  });

  describe('política de la clínica', () => {
    afterAll(async () => {
      await as(clinicA)
        .put('/discount-policy', {
          maxPercentByRole: {
            ADMIN: 100,
            DENTIST: 10,
            ASSISTANT: 0,
            RECEPTION: 0,
          },
          reasonRequiredAbovePercent: 10,
        })
        .expect(200);
    });

    it('por defecto ADMIN 100, DENTIST 10, el resto 0; motivo por encima del 10 %', async () => {
      const res = await as(clinicB).get('/discount-policy').expect(200);
      expect(res.body).toMatchObject({
        maxPercentByRole: {
          ADMIN: 100,
          DENTIST: 10,
          ASSISTANT: 0,
          RECEPTION: 0,
        },
        reasonRequiredAbovePercent: 10,
        isDefault: true,
      });
    });

    it('solo ADMIN la cambia; el cambio se aplica en el servidor y se audita', async () => {
      const policy = {
        maxPercentByRole: {
          ADMIN: 100,
          DENTIST: 20,
          ASSISTANT: 5,
          RECEPTION: 0,
        },
        reasonRequiredAbovePercent: 15,
      };
      const denied = await as(clinicA, tokens.DENTIST)
        .put('/discount-policy', policy)
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        'Solo la administración cambia la política de descuentos.',
      );
      await as(clinicA)
        .put('/discount-policy', { ...policy, reasonRequiredAbovePercent: 101 })
        .expect(400);
      const requestId = nextRequestId();
      const saved = await as(clinicA)
        .put('/discount-policy', policy)
        .set('X-Request-Id', requestId)
        .expect(200);
      expect(saved.body).toMatchObject({ ...policy, isDefault: false });
      const [event] = await raw.auditEvent.findMany({ where: { requestId } });
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceType: 'DISCOUNT_POLICY',
      });
      // La otra clínica sigue con la suya.
      const other = await as(clinicB).get('/discount-policy').expect(200);
      expect((other.body as { isDefault: boolean }).isDefault).toBe(true);

      const planId = await newPlan();
      await addItem(planId, 1000000, { discount: 150000 }, tokens.DENTIST);
      await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '36',
          catalogItemId: catalogA,
          price: 1000000,
          discount: 200000,
        })
        .expect(422);
    });
  });

  describe('informe de descuentos', () => {
    let reportPlan: string;
    let northItem: Item;
    let deletedItem: Item;

    beforeAll(async () => {
      reportPlan = await newPlan();
      const res = await as(clinicA, tokens.DENTIST, northLocationA)
        .post(`/treatment-plans/${reportPlan}/items`, {
          toothNumber: '11',
          catalogItemId: catalogA,
          price: 500000,
          discount: 25000,
        })
        .expect(201);
      northItem = res.body as Item;
      deletedItem = await addItem(reportPlan, 400000, { discount: 20000 });
      await as(clinicA)
        .delete(`/treatment-plans/${reportPlan}/items/${deletedItem.id}`)
        .expect(200);
      // Uno de hace 40 días: fuera del periodo de esta semana.
      const old = await addItem(reportPlan, 300000, { discount: 30000 });
      await raw.treatmentPlanItem.update({
        where: { id: old.id },
        data: { discountAt: new Date(Date.now() - 40 * DAY) },
      });
    });

    const period = () => `from=${bogotaDay(-7)}&to=${bogotaDay(0)}`;

    it('cuadra con la suma del descuento efectivo de los ítems vivos del periodo', async () => {
      const res = await as(clinicA)
        .get(`/reports/discounts?${period()}&pageSize=200`)
        .expect(200);
      const report = res.body as Report;
      const from = new Date(Date.now() - 9 * DAY);
      const candidates = await raw.treatmentPlanItem.findMany({
        where: {
          tenantId: clinicA.tenantId,
          deletedAt: null,
          discountAt: { gte: from },
          plan: {
            currency: 'COP',
            deletedAt: null,
            status: { notIn: ['REJECTED', 'CANCELLED'] },
          },
        },
      });
      // SEC-041: descuento efectivo = rebaja frente al catálogo + discount.
      const reduction = (i: (typeof candidates)[number]) =>
        Math.max(0, Number(i.catalogPrice ?? i.price) - Number(i.price));
      const live = candidates.filter(
        (i) => Number(i.discount) > 0 || reduction(i) > 0,
      );
      const expected = live.reduce(
        (s, i) => s + Number(i.discount) + reduction(i),
        0,
      );
      const gross = live.reduce(
        (s, i) => s + Number(i.price) + reduction(i),
        0,
      );
      const cop = report.totals.find((t) => t.currency === 'COP')!;
      expect(cop.discount).toBe(expected);
      expect(cop.gross).toBe(gross);
      expect(cop.items).toBe(live.length);
      expect(cop.percentOfGross).toBe(
        Math.round((expected / gross) * 10000) / 100,
      );
      const ids = report.items.map((i) => i.itemId);
      expect(ids).toContain(northItem.id);
      expect(ids).not.toContain(deletedItem.id);
      const row = report.items.find((i) => i.itemId === northItem.id)!;
      expect(row).toMatchObject({
        patientName: 'Ana Descuento',
        discount: 25000,
        percent: 5,
        discountByName: 'Miembro DENTIST',
        locationId: northLocationA,
      });
    });

    it('filtra por sede y por profesional', async () => {
      const north = await as(clinicA)
        .get(`/reports/discounts?${period()}&locationId=${northLocationA}`)
        .expect(200);
      expect(
        (north.body as Report).items.every(
          (i) => i.locationId === northLocationA,
        ),
      ).toBe(true);
      expect((north.body as Report).items.map((i) => i.itemId)).toContain(
        northItem.id,
      );
      const byDentist = await as(clinicA)
        .get(
          `/reports/discounts?${period()}&professionalId=${dentistId}&pageSize=200`,
        )
        .expect(200);
      const rows = (byDentist.body as Report).items;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((i) => i.discountByName === 'Miembro DENTIST')).toBe(
        true,
      );
      // La cabecera X-Location-Id también filtra.
      const header = await as(clinicA, tokens.ADMIN, mainLocationA)
        .get(`/reports/discounts?${period()}&pageSize=200`)
        .expect(200);
      expect((header.body as Report).items.map((i) => i.itemId)).not.toContain(
        northItem.id,
      );
    });

    it('no cuenta los planes anulados: ni la opción rechazada (copia del descuento, DX-040) ni el cancelado', async () => {
      const chosen = await newPlan();
      const kept = await addItem(chosen, 400000, { discount: 40000 });
      const alt = await as(clinicA)
        .post(`/treatment-plans/${chosen}/alternatives`, {})
        .expect(201);
      const altId = (alt.body as { id: string }).id;
      const [copied] = await planItems(altId);
      expect(copied.discount).toBe(40000);
      await as(clinicA)
        .patch(`/treatment-plans/${chosen}`, { status: 'ACCEPTED' })
        .expect(200);
      const cancelled = await newPlan();
      const voided = await addItem(cancelled, 300000, { discount: 15000 });
      await as(clinicA)
        .patch(`/treatment-plans/${cancelled}`, { status: 'CANCELLED' })
        .expect(200);

      const res = await as(clinicA)
        .get(`/reports/discounts?${period()}&pageSize=200`)
        .expect(200);
      const ids = (res.body as Report).items.map((i) => i.itemId);
      expect(ids).toContain(kept.id);
      expect(ids).not.toContain(copied.id);
      expect(ids).not.toContain(voided.id);
      const csv = await as(clinicA)
        .get(`/reports/discounts.csv?${period()}`)
        .expect(200);
      const lines = csv.text.split('\r\n').filter(Boolean);
      expect(lines).toHaveLength(
        (res.body as Report).total + 1, // + cabecera
      );
      expect(csv.text).not.toContain('Rechazado');
      expect(csv.text).not.toContain('Cancelado');
    });

    it('CSV con BOM, protegido contra fórmulas y auditado como EXPORT', async () => {
      await as(clinicA)
        .patch(`/patients/${patientA}`, { firstName: '=Ana' })
        .expect(200);
      const requestId = nextRequestId();
      const res = await as(clinicA)
        .get(`/reports/discounts.csv?${period()}`)
        .set('X-Request-Id', requestId)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text.startsWith('﻿Fecha,Paciente,')).toBe(true);
      expect(res.text).toContain(`"'=Ana Descuento"`);
      expect(res.text).not.toContain(`"=Ana`);
      const [event] = await raw.auditEvent.findMany({ where: { requestId } });
      expect(event).toMatchObject({
        action: 'EXPORT',
        resourceType: 'TREATMENT_PLAN_ITEM',
      });
      expect(event.metadata).toMatchObject({ reason: 'DISCOUNT_REPORT' });
      await as(clinicA)
        .patch(`/patients/${patientA}`, { firstName: 'Ana' })
        .expect(200);
    });

    it('solo ADMIN; periodo inválido o de más de 366 días: 400', async () => {
      const denied = await as(clinicA, tokens.DENTIST)
        .get(`/reports/discounts?${period()}`)
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        'Solo la administración ve el informe de descuentos.',
      );
      await as(clinicA)
        .get(`/reports/discounts?from=${bogotaDay(0)}&to=${bogotaDay(-1)}`)
        .expect(400);
      await as(clinicA)
        .get(`/reports/discounts?from=${bogotaDay(-400)}&to=${bogotaDay(0)}`)
        .expect(400);
    });

    it('aislamiento por clínica: B no ve nada de A, ni con la sede de A', async () => {
      const res = await as(clinicB)
        .get(`/reports/discounts?${period()}`)
        .expect(200);
      expect(res.body).toMatchObject({ totals: [], items: [], total: 0 });
      await as(clinicB)
        .get(`/reports/discounts?${period()}&locationId=${northLocationA}`)
        .expect(400);
      const csv = await as(clinicB)
        .get(`/reports/discounts.csv?${period()}`)
        .expect(200);
      expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(1);
    });
  });
  // SEC-041: bajar el precio por debajo del de catálogo cuenta como descuento
  // (tope del rol y motivo de DX-204) en el alta, la edición y el bloque, y
  // sale en el informe con su importe, autor y sede.
  describe('precio por debajo del de catálogo = descuento (SEC-041)', () => {
    const CAP_0 =
      'Precio por debajo del de catálogo: cuenta como descuento. Tu rol permite hasta un 0 % de descuento por ítem.';
    const CAP_10 =
      'Precio por debajo del de catálogo: cuenta como descuento. Tu rol permite hasta un 10 % de descuento por ítem.';
    const REASON =
      'Precio por debajo del de catálogo: cuenta como descuento y supera el 10 %. Indica el motivo del descuento.';
    const period = () => `from=${bogotaDay(-1)}&to=${bogotaDay(1)}`;

    async function report(): Promise<Report> {
      const res = await as(clinicA)
        .get(`/reports/discounts?${period()}&pageSize=200`)
        .expect(200);
      return res.body as Report;
    }

    function addCrown(
      planId: string,
      body: object,
      token = tokens.ADMIN,
      location?: string,
    ) {
      return as(clinicA, token, location).post(
        `/treatment-plans/${planId}/items`,
        { toothNumber: '16', catalogItemId: crownA, ...body },
      );
    }

    it('alta: DENTIST (10 %) con el precio al 50 % del catálogo → 403 en español; al 95 % → 201 a su nombre', async () => {
      const planId = await newPlan();
      const denied = await addCrown(
        planId,
        { price: 500000 },
        tokens.DENTIST,
      ).expect(403);
      expect((denied.body as { message: string }).message).toBe(CAP_10);
      expect(await planItems(planId)).toHaveLength(0);

      const ok = await addCrown(
        planId,
        { price: 950000 },
        tokens.DENTIST,
        northLocationA,
      ).expect(201);
      expect(ok.body).toMatchObject({
        catalogPrice: 1000000,
        price: 950000,
        discount: 0,
        discountById: dentistId,
        discountLocationId: northLocationA,
      });
      expect((ok.body as Item).discountAt).not.toBeNull();
      // La rebaja y el descuento se suman: 5 % + 6 % supera su 10 %.
      await addCrown(
        planId,
        { price: 950000, discount: 60000 },
        tokens.DENTIST,
      ).expect(403);
    });

    it('edición: ASSISTANT baja el precio → 403 y no cambia; lo sube → 200 sin firma de descuento', async () => {
      const planId = await newPlan();
      // Sin precio: el de catálogo.
      const item = (await addCrown(planId, {}).expect(201)).body as Item;
      expect(item).toMatchObject({ price: 1000000, discountById: null });

      const denied = await as(clinicA, tokens.ASSISTANT)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, { price: 1 })
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(CAP_0);
      const [unchanged] = await planItems(planId);
      expect(unchanged.price).toBe(1000000);

      const raised = await as(clinicA, tokens.ASSISTANT)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          price: 1100000,
        })
        .expect(200);
      expect(raised.body).toMatchObject({
        price: 1100000,
        discountById: null,
        discountReason: null,
      });
    });

    it('rebaja por encima del umbral: 422 «Indica el motivo del descuento» sin motivo; con motivo, 201 y sale en el informe con importe, autor y sede', async () => {
      const planId = await newPlan();
      const missing = await addCrown(planId, { price: 800000 }).expect(422);
      expect((missing.body as { message: string }).message).toBe(REASON);
      // También en la edición.
      const atCatalog = (await addCrown(planId, {}).expect(201)).body as Item;
      const missingEdit = await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${atCatalog.id}`, {
          price: 800000,
        })
        .expect(422);
      expect((missingEdit.body as { message: string }).message).toContain(
        'Indica el motivo del descuento',
      );

      const created = await addCrown(
        planId,
        { price: 800000, discountReason: 'PROMOTION' },
        tokens.ADMIN,
        northLocationA,
      ).expect(201);
      const item = created.body as Item;
      expect(item).toMatchObject({
        catalogPrice: 1000000,
        price: 800000,
        discount: 0,
        discountReason: 'PROMOTION',
        discountLocationId: northLocationA,
      });
      expect(item.discountById).not.toBeNull();

      const row = (await report()).items.find((i) => i.itemId === item.id);
      expect(row).toMatchObject({
        catalogPrice: 1000000,
        price: 800000,
        priceReduction: 200000,
        itemDiscount: 0,
        discount: 200000,
        percent: 20,
        reason: 'PROMOTION',
        discountById: item.discountById,
        locationId: northLocationA,
      });
      expect(row!.discountByName).toEqual(expect.any(String));
      // El ítem que quedó al precio de catálogo no es un descuento.
      expect((await report()).items.map((i) => i.itemId)).not.toContain(
        atCatalog.id,
      );

      const csv = await as(clinicA)
        .get(`/reports/discounts.csv?${period()}`)
        .expect(200);
      expect(csv.text).toContain(
        'COP,1000000,800000,200000,0,200000,20.00,"Promoción o campaña"',
      );
    });

    it('ADMIN puede fijar cualquier precio (con motivo) y queda en el informe a su nombre', async () => {
      const planId = await newPlan();
      const item = (await addCrown(planId, {}).expect(201)).body as Item;
      const res = await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          price: 1,
          discountReason: 'SERVICE_RECOVERY',
        })
        .expect(200);
      const updated = res.body as Item;
      expect(updated).toMatchObject({
        price: 1,
        discountReason: 'SERVICE_RECOVERY',
      });
      expect(updated.discountById).not.toBeNull();
      const row = (await report()).items.find((i) => i.itemId === item.id);
      expect(row).toMatchObject({
        priceReduction: 999999,
        discount: 999999,
        discountById: updated.discountById,
        reason: 'SERVICE_RECOVERY',
      });
    });

    it('un ítem libre (sin precio de catálogo) no se trata como descuento', async () => {
      const planId = await newPlan();
      const res = await as(clinicA, tokens.ASSISTANT)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '17',
          catalogItemId: catalogA,
          price: 1,
        })
        .expect(201);
      const item = res.body as Item;
      expect(item).toMatchObject({
        catalogPrice: null,
        price: 1,
        discountById: null,
      });
      await as(clinicA, tokens.ASSISTANT)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, { price: 0 })
        .expect(200);
      expect((await report()).items.map((i) => i.itemId)).not.toContain(
        item.id,
      );
    });

    it('«Descuento %» en bloque suma la rebaja de precio al tope del rol', async () => {
      const planId = await newPlan();
      const item = (
        await addCrown(planId, { price: 950000 }, tokens.DENTIST).expect(201)
      ).body as Item;
      const denied = await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: [item.id],
          percent: 6,
        })
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(CAP_10);
      expect((await planItems(planId))[0].discount).toBe(0);
      // 5 % del precio (47.500) + la rebaja (50.000) = 9,75 % del catálogo.
      const ok = await as(clinicA, tokens.DENTIST)
        .post(`/treatment-plans/${planId}/items/bulk-discount`, {
          itemIds: [item.id],
          percent: 5,
        })
        .expect(200);
      expect((ok.body as Item[])[0]).toMatchObject({
        discount: 47500,
        discountById: dentistId,
      });
      const row = (await report()).items.find((i) => i.itemId === item.id);
      expect(row).toMatchObject({
        priceReduction: 50000,
        itemDiscount: 47500,
        discount: 97500,
        percent: 9.75,
      });
    });

    it('el cliente no puede mover la referencia: `catalogPrice` en el alta y `catalogItemId` en la edición se ignoran', async () => {
      const planId = await newPlan();
      // Un `catalogPrice` falso en el body no rebaja la referencia.
      const denied = await addCrown(
        planId,
        { price: 500000, catalogPrice: 500000 },
        tokens.DENTIST,
      ).expect(403);
      expect((denied.body as { message: string }).message).toBe(CAP_10);

      // Cambiar el ítem a un procedimiento sin precio (ítem libre) en la
      // edición no le quita la referencia de catálogo.
      const item = (await addCrown(planId, {}).expect(201)).body as Item;
      await as(clinicA, tokens.ASSISTANT)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          catalogItemId: catalogA,
          catalogPrice: null,
          price: 1,
        })
        .expect(403);
      const [unchanged] = await planItems(planId);
      expect(unchanged).toMatchObject({
        catalogItemId: crownA,
        catalogPrice: 1000000,
        price: 1000000,
      });
    });

    it('un plan aceptado no admite bajar el precio de catálogo (409)', async () => {
      const planId = await newPlan();
      const item = (await addCrown(planId, {}).expect(201)).body as Item;
      await as(clinicA)
        .patch(`/treatment-plans/${planId}`, { status: 'ACCEPTED' })
        .expect(200);
      await as(clinicA)
        .patch(`/treatment-plans/${planId}/items/${item.id}`, {
          price: 990000,
        })
        .expect(409);
      await addCrown(planId, { price: 990000 }).expect(409);
    });
  });
});
