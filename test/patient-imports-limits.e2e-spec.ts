import { readdirSync, mkdirSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  IMPORT_READ_BUSY_MESSAGE,
  IMPORT_READ_CLINIC_BUSY_MESSAGE,
  IMPORT_READ_SLOTS,
} from '../src/modules/patient-imports/presentation/import-read-slots';
import {
  RATE_LIMIT_CONFIG,
  loadRateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { tooManyRequestsException } from '../src/shared/security/too-many-requests';
import { UPLOAD_TEMP_DIR } from '../src/shared/storage/local-file';
import type { UploadSlots } from '../src/shared/storage/upload-slots';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { waitFor } from './support/wait-for';

// SEC-046 · La lectura de un fichero de importación (inspect, dry-run y hoja
// de saldos) pesa decenas de MB por petición: como mucho 2 a la vez en la
// réplica y 1 por clínica (503 en español con Retry-After, sin leer el
// cuerpo), la plaza después de la autenticación y del rol, el fichero a un
// temporal en disco que se borra al terminar (también si el cliente aborta) y
// la política `patient-import`: 10 lecturas por minuto por clínica + usuario.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HEADER =
  'tipo_documento;numero_documento;nombres;apellidos;fecha_nacimiento;sexo;telefono;email;notas';
const CSV = Buffer.from(
  `${HEADER}\nCC;46000001;Ana;Tope;01/02/1990;F;3100000001;ana@example.com;\n`,
  'utf8',
);
const BOUNDARY = '----sec046boundary';

interface ErrorBody {
  statusCode: number;
  message: string;
}

const tempFiles = (): Set<string> => {
  mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
  return new Set(readdirSync(UPLOAD_TEMP_DIR));
};

describe('Importación de pacientes: tope de lecturas y throttle (SEC-046, e2e)', () => {
  let app: INestApplication<App>;
  let slots: UploadSlots;
  let port: number;
  let a: Clinic;
  let b: Clinic;
  let c: Clinic;
  let d: Clinic;
  let reception: string;
  const open: ClientRequest[] = [];

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const read = (clinic: Clinic, path = '/inspect', token = clinic.adminToken) =>
    as(api().post(`/api/v1/patient-imports${path}`), clinic, token).attach(
      'file',
      CSV,
      { filename: 'pacientes.csv', contentType: 'text/csv' },
    );

  /**
   * Una lectura en vuelo de verdad: manda las cabeceras y la mitad del
   * multipart y se queda esperando. La plaza la tiene desde que pasa el
   * guard (antes de que multer lea el cuerpo).
   */
  const slowRead = (clinic: Clinic): ClientRequest => {
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="lento.csv"\r\nContent-Type: text/csv\r\n\r\n${HEADER}\n`,
    );
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/v1/patient-imports/inspect',
      headers: {
        'X-Tenant-Host': clinic.host,
        Authorization: `Bearer ${clinic.adminToken}`,
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        'Content-Length': String(head.length + 1024),
      },
    });
    req.on('error', () => undefined);
    req.on('response', (res) => res.resume());
    req.write(head);
    open.push(req);
    return req;
  };

  const expectBusy = (res: request.Response, message: string) => {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect((res.body as ErrorBody).message).toBe(message);
  };

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(RATE_LIMIT_CONFIG).useValue({
          // Los altos de setup-e2e, salvo `patient-import` con su default.
          ...loadRateLimitConfig((k) => process.env[k]),
          'patient-import': { limit: 10, ttlMs: 60_000 },
        }),
    });
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
    slots = app.get<UploadSlots>(IMPORT_READ_SLOTS);
    await resetDatabase(raw);
    a = await registerClinic(app, 'sec046-a');
    b = await registerClinic(app, 'sec046-b');
    c = await registerClinic(app, 'sec046-c');
    d = await registerClinic(app, 'sec046-d');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
  });

  afterEach(() => {
    open.splice(0).forEach((req) => req.destroy());
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('por defecto: 2 plazas por réplica y 1 por clínica', () => {
    expect(slots.capacity).toBe(2);
    expect(slots.perKeyCapacity).toBe(1);
  });

  it('plaza ocupada → la segunda lectura de la clínica y la de otra clínica con la réplica llena dan 503 con Retry-After; al abortar el cliente, plazas y temporales vuelven', async () => {
    const before = tempFiles();
    const slowA = slowRead(a);
    await waitFor(() => slots.activeFor(a.tenantId) === 1, 'A lee');

    // La misma clínica: espera a que termine la suya.
    expectBusy(await read(a), IMPORT_READ_CLINIC_BUSY_MESSAGE);
    // Otra clínica entra en la segunda plaza de la réplica.
    expect((await read(b)).status).toBe(200);
    expect(slots.active).toBe(1);

    const slowC = slowRead(c);
    await waitFor(() => slots.active === 2, 'A y C leen');
    // Réplica llena: B no entra en ninguna de las rutas que leen un fichero.
    expectBusy(await read(b), IMPORT_READ_BUSY_MESSAGE);
    expectBusy(await read(b, ''), IMPORT_READ_BUSY_MESSAGE);
    expectBusy(
      await read(b, '/00000000-0000-4000-8000-000000000000/balances'),
      IMPORT_READ_BUSY_MESSAGE,
    );

    // Los clientes se van a mitad de la subida: plazas libres y sin temporales.
    slowA.destroy();
    slowC.destroy();
    await waitFor(() => slots.active === 0, 'plazas devueltas');
    await waitFor(
      () => [...tempFiles()].every((name) => before.has(name)),
      'temporales borrados',
    );
    expect((await read(b)).status).toBe(200);
  });

  it('un anónimo o un no-ADMIN no ocupa plaza: con la réplica llena reciben 401/403, no 503', async () => {
    const held = [slots.tryAcquire('x'), slots.tryAcquire('y')];
    try {
      expect(slots.active).toBe(2);
      await api()
        .post('/api/v1/patient-imports/inspect')
        .set('X-Tenant-Host', a.host)
        .attach('file', CSV, { filename: 'p.csv', contentType: 'text/csv' })
        .expect(401);
      const denied = await read(a, '/inspect', reception).expect(403);
      expect((denied.body as ErrorBody).message).toBe(
        'Solo un administrador de la clínica puede importar pacientes.',
      );
      expectBusy(await read(a), IMPORT_READ_BUSY_MESSAGE);
    } finally {
      held.forEach((release) => release?.());
    }
    expect(slots.active).toBe(0);
  });

  it('el fichero va a un temporal en disco que se borra al terminar, bien o con 400', async () => {
    const before = tempFiles();
    expect((await read(a)).status).toBe(200);
    const bad = await as(api().post('/api/v1/patient-imports/inspect'), a)
      .attach('file', Buffer.from('no es una tabla'), {
        filename: 'p.xlsx',
        contentType: 'application/octet-stream',
      })
      .expect(400);
    expect((bad.body as ErrorBody).message).toMatch(/extensión/);
    expect(slots.active).toBe(0);
    await waitFor(
      () => [...tempFiles()].every((name) => before.has(name)),
      'temporales borrados',
    );
  });

  it('11.ª lectura en un minuto (inspect y dry-run comparten balde) → 429 en español; otro usuario de la clínica sigue', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await read(d)).status).toBe(200);
      expect((await read(d, '')).status).toBe(201);
    }
    for (const path of ['/inspect', '']) {
      const res = await read(d, path);
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res.body).toEqual(
        tooManyRequestsException(retryAfter).getResponse(),
      );
    }
    // El 429 no tomó plaza.
    expect(slots.active).toBe(0);
    const otherAdmin = await loginAs(
      app,
      d.host,
      (await seedMember(raw, d, ClinicRole.ADMIN)).email,
    );
    expect((await read(d, '/inspect', otherAdmin)).status).toBe(200);
  });
});
