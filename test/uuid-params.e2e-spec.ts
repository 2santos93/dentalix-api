import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  type Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';

// SEC-069 (barrido completo): un `:id` que no es UUID da 400 con el cuerpo
// estándar de `ParseUUIDPipe` (el mismo que `appointments.controller`), no un
// 500 de Prisma. Un UUID válido que no es de la clínica sigue dando 404, como
// antes, sin filtrar nada del recurso ajeno.
//
// DIRECT_URL (superusuario, sin RLS) solo para limpiar la base al final.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOT_A_UUID = 'no-es-un-uuid';
const UUID_400 = {
  statusCode: 400,
  message: 'Validation failed (uuid is expected)',
  error: 'Bad Request',
};

type Method = 'get' | 'post' | 'patch' | 'delete';

// Una fila por ruta corregida, con un cuerpo válido: lo único mal formado es
// el `:id`, así que el 400 tiene que ser el del pipe y no el del DTO.
const ROUTES: [Method, string, object][] = [
  [
    'post',
    '/treatment-plans/:id/payments',
    { amount: 100, currency: 'USD', paidAt: '2026-11-01' },
  ],
  ['get', '/treatment-plans/:id/payments', {}],
  ['get', '/treatment-plans/:id/balance', {}],
  ['delete', '/payments/:id', { reason: 'Cobro duplicado' }],
  ['get', '/patients/:id', {}],
  ['patch', '/patients/:id', { firstName: 'Lucía' }],
  ['patch', '/locations/:id', { name: 'Sede Norte' }],
  ['patch', '/catalog/items/:id', { name: 'Limpieza' }],
  [
    'post',
    '/treatment-plans/:id/payment-plan',
    { installmentsCount: 3, periodicity: 'MONTHLY', startDate: '2026-12-01' },
  ],
  ['get', '/treatment-plans/:id/payment-plan', {}],
  ['delete', '/treatment-plans/:id/payment-plan', {}],
  ['get', '/inventory/items/:id', {}],
  ['patch', '/inventory/items/:id', { name: 'Guantes' }],
  ['delete', '/inventory/items/:id', {}],
  ['post', '/inventory/items/:id/movements', { type: 'IN', quantity: 10 }],
  ['get', '/inventory/items/:id/movements', {}],
];

// Un UUID válido que no existe en la clínica: el mismo 404 que antes.
const NOT_FOUND_ROUTES: [Method, string][] = [
  ['get', '/treatment-plans/:id/balance'],
  ['patch', '/locations/:id'],
  ['patch', '/catalog/items/:id'],
  ['get', '/treatment-plans/:id/payment-plan'],
  ['get', '/inventory/items/:id'],
];

describe('Ids de ruta que no son UUID: 400, no 500 (SEC-069)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let foreignPatientId: string;
  let openApi: OpenAPIObject;

  const call = (c: Clinic, method: Method, path: string, body: object = {}) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${c.adminToken}`);
    return method === 'get' ? req : req.send(body);
  };

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinic = await registerClinic(app, 'sec069-uuid');
    other = await registerClinic(app, 'sec069-uuid-otra');
    const created = await call(other, 'post', '/patients', {
      firstName: 'Paciente',
      lastName: 'Ajeno',
      docType: 'NATIONAL_ID',
      docNumber: 'SEC069-AJENO',
      sex: Sex.F,
      phone: '+58 414 555 0170',
    }).expect(201);
    foreignPatientId = (created.body as { id: string }).id;
    openApi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it.each(ROUTES)(
    '%s %s con id mal formado → 400',
    async (method, path, body) => {
      const res = await call(
        clinic,
        method,
        path.replace(':id', NOT_A_UUID),
        body,
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(UUID_400);
    },
  );

  it.each(NOT_FOUND_ROUTES)(
    '%s %s con un UUID válido inexistente → 404, como antes',
    async (method, path) => {
      const res = await call(clinic, method, path.replace(':id', randomUUID()));
      expect(res.status).toBe(404);
    },
  );

  it('GET /patients/:id de otra clínica → 404, sin datos del paciente', async () => {
    const res = await call(clinic, 'get', `/patients/${foreignPatientId}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Ajeno');
    expect(JSON.stringify(res.body)).not.toContain(foreignPatientId);
  });

  it.each(ROUTES)(
    '%s %s: OpenAPI documenta el id como uuid y el 400',
    (method, path) => {
      const operation =
        openApi.paths[`/api/v1${path.replace(':id', '{id}')}`]?.[method];
      const idParam = operation?.parameters?.find(
        (p) => 'in' in p && p.in === 'path' && p.name === 'id',
      );
      expect(idParam && 'schema' in idParam ? idParam.schema : null).toEqual({
        type: 'string',
        format: 'uuid',
      });
      expect(operation?.responses['400']).toBeDefined();
    },
  );

  it('GET /patients/:id propio sigue dando 200', async () => {
    const res = await call(other, 'get', `/patients/${foreignPatientId}`);
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(foreignPatientId);
  });
});
