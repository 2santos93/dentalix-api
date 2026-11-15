import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';

/**
 * DX-111: entradas que antes daban 500, se aceptaban sin tope o respondían en
 * inglés. La app se monta como main.ts (configureApp: ValidationPipe y filtro
 * global reales).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

describe('Entradas sin 500 y errores en español (DX-111)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let catalogItemId: string;

  const call = (method: Method, path: string, body?: object) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
    return body === undefined ? req : req.send(body);
  };

  async function planWithItem(): Promise<{ planId: string; itemId: string }> {
    const plan = await call('post', `/patients/${patientId}/treatment-plans`, {
      currency: 'VES',
    }).expect(201);
    const planId = (plan.body as { id: string }).id;
    const item = await call('post', `/treatment-plans/${planId}/items`, {
      toothNumber: '36',
      catalogItemId,
      price: 40,
    }).expect(201);
    return { planId, itemId: (item.body as { id: string }).id };
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinic = await registerClinic(app, 'dx111-entradas');
    const patient = await call('post', '/patients', {
      firstName: 'Lucía',
      lastName: 'Entradas',
      docType: 'NATIONAL_ID',
      docNumber: 'DX111-0001',
      sex: Sex.F,
      phone: '+58 414 555 0111',
    }).expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await call('post', '/catalog/items', {
      code: 'DX111-RES',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Resina',
      color: '#2A2B3C',
      defaultPrice: 40,
    }).expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('ítems de plan bajo /treatment-plans/:id (BE-007)', () => {
    it('PATCH de un ítem de OTRO plan → 404 y el ítem no cambia', async () => {
      const a = await planWithItem();
      const b = await planWithItem();
      const res = await call(
        'patch',
        `/treatment-plans/${b.planId}/items/${a.itemId}`,
        { price: 99 },
      );
      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'No se encontró el ítem en este plan de tratamiento.',
      );
      const plan = await call('get', `/treatment-plans/${a.planId}`).expect(
        200,
      );
      const items = (plan.body as { items: { id: string; price: number }[] })
        .items;
      expect(items.find((i) => i.id === a.itemId)?.price).toBe(40);
    });

    it('DELETE de un ítem de OTRO plan → 404 y el ítem sigue', async () => {
      const a = await planWithItem();
      const b = await planWithItem();
      await call(
        'delete',
        `/treatment-plans/${b.planId}/items/${a.itemId}`,
      ).expect(404);
      const plan = await call('get', `/treatment-plans/${a.planId}`).expect(
        200,
      );
      expect(
        (plan.body as { items: { id: string }[] }).items.map((i) => i.id),
      ).toContain(a.itemId);
    });

    it('con su propio plan sigue funcionando', async () => {
      const a = await planWithItem();
      await call('patch', `/treatment-plans/${a.planId}/items/${a.itemId}`, {
        price: 55,
      }).expect(200);
      await call(
        'delete',
        `/treatment-plans/${a.planId}/items/${a.itemId}`,
      ).expect(200);
    });
  });
});
