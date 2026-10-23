import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PatientImportsService } from '../src/modules/patient-imports/application/patient-imports.use-cases';
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
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_SLOTS,
  type UploadSlots,
} from '../src/shared/storage/upload-slots';
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
// de saldos) pesa decenas de MB por petición. El cuerpo se recibe a un
// temporal en disco con el semáforo y los plazos de las subidas (DX-259); la
// plaza de LECTURA (2 por réplica, 1 por clínica) se toma DESPUÉS, con el
// fichero ya en disco: una subida lenta no la retiene. Sin plaza, 503 en
// español con Retry-After y el temporal borrado. Todo después de la
// autenticación y del rol. Política `patient-import`: 10 lecturas por minuto
// por clínica + usuario.
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
  let readSlots: UploadSlots;
  let uploadSlots: UploadSlots;
  let port: number;
  let a: Clinic;
  let b: Clinic;
  let d: Clinic;
  let reception: string;
  const open: ClientRequest[] = [];
  const held: (() => void)[] = [];

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

  /** Toma a mano una plaza de lectura de `key` (se devuelve en afterEach). */
  const holdRead = (key: string) => {
    const release = readSlots.tryAcquire(key);
    if (!release) throw new Error(`sin plaza de lectura para ${key}`);
    held.push(release);
  };

  /**
   * Una subida lenta de verdad: manda las cabeceras y la mitad del multipart
   * y se queda esperando (como quien gotea el cuerpo por debajo del plazo de
   * inactividad).
   */
  const slowUpload = (clinic: Clinic): ClientRequest => {
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

  const expectNoNewTempFiles = (before: Set<string>) =>
    waitFor(
      () => [...tempFiles()].every((name) => before.has(name)),
      'temporales borrados',
    );

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
    readSlots = app.get<UploadSlots>(IMPORT_READ_SLOTS);
    uploadSlots = app.get<UploadSlots>(UPLOAD_SLOTS);
    await resetDatabase(raw);
    a = await registerClinic(app, 'sec046-a');
    b = await registerClinic(app, 'sec046-b');
    d = await registerClinic(app, 'sec046-d');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
  });

  afterEach(async () => {
    open.splice(0).forEach((req) => req.destroy());
    held.splice(0).forEach((release) => release());
    jest.restoreAllMocks();
    await waitFor(
      () => uploadSlots.active === 0 && readSlots.active === 0,
      'plazas libres entre tests',
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('por defecto: 2 plazas de lectura por réplica y 1 por clínica', () => {
    expect(readSlots.capacity).toBe(2);
    expect(readSlots.perKeyCapacity).toBe(1);
  });

  it('una subida lenta en curso no retiene plaza de lectura: lecturas completas de otra clínica y de la misma dan 200; al abortar, plaza de subida y temporal vuelven', async () => {
    const before = tempFiles();
    const slowA = slowUpload(a);
    await waitFor(() => uploadSlots.active === 1, 'A sube despacio');
    expect(readSlots.active).toBe(0);

    expect((await read(b)).status).toBe(200);
    expect((await read(b, '')).status).toBe(201);
    expect((await read(a)).status).toBe(200);
    expect(readSlots.active).toBe(0);

    slowA.destroy();
    await waitFor(() => uploadSlots.active === 0, 'plaza de subida devuelta');
    await expectNoNewTempFiles(before);
  });

  it('plaza de lectura ocupada → la segunda lectura de la clínica y la de otra clínica con la réplica llena dan 503 con Retry-After, ya recibido el fichero, y su temporal se borra', async () => {
    const before = tempFiles();
    holdRead(a.tenantId);
    // La misma clínica: espera a que termine la suya.
    expectBusy(await read(a), IMPORT_READ_CLINIC_BUSY_MESSAGE);
    // Otra clínica entra en la segunda plaza de la réplica.
    expect((await read(b)).status).toBe(200);

    holdRead('otra-clinica');
    // Réplica llena: B no entra en ninguna de las rutas que leen un fichero.
    expectBusy(await read(b), IMPORT_READ_BUSY_MESSAGE);
    expectBusy(await read(b, ''), IMPORT_READ_BUSY_MESSAGE);
    expectBusy(
      await read(b, '/00000000-0000-4000-8000-000000000000/balances'),
      IMPORT_READ_BUSY_MESSAGE,
    );
    expect(readSlots.active).toBe(2);
    expect(uploadSlots.active).toBe(0);
    await expectNoNewTempFiles(before);
  });

  it('un anónimo o un no-ADMIN no ocupa plaza: con las plazas llenas reciben 401/403, no 503', async () => {
    const anonymous = () =>
      api()
        .post('/api/v1/patient-imports/inspect')
        .set('X-Tenant-Host', a.host)
        .attach('file', CSV, { filename: 'p.csv', contentType: 'text/csv' });

    // Plazas de LECTURA llenas.
    holdRead('x');
    holdRead('y');
    await anonymous().expect(401);
    const denied = await read(a, '/inspect', reception).expect(403);
    expect((denied.body as ErrorBody).message).toBe(
      'Solo un administrador de la clínica puede importar pacientes.',
    );
    expectBusy(await read(a), IMPORT_READ_BUSY_MESSAGE);

    // Plazas de SUBIDA llenas (DX-259): el cuerpo ni se lee.
    const uploads: (() => void)[] = [];
    for (let r = uploadSlots.tryAcquire(); r; r = uploadSlots.tryAcquire()) {
      uploads.push(r);
    }
    try {
      await anonymous().expect(401);
      await read(a, '/inspect', reception).expect(403);
      expectBusy(await read(a), UPLOAD_BUSY_MESSAGE);
    } finally {
      uploads.forEach((release) => release());
    }
  });

  it('el fichero se lee desde un temporal en disco del directorio de subidas, que se borra al terminar, bien o con 400', async () => {
    const before = tempFiles();
    const service = app.get(PatientImportsService);
    const original = service.inspect.bind(service);
    const seen: Buffer[] = [];
    jest.spyOn(service, 'inspect').mockImplementation(async (file) => {
      // Durante la lectura el fichero está en disco, con su contenido.
      for (const name of tempFiles()) {
        if (!before.has(name)) {
          seen.push(readFileSync(path.join(UPLOAD_TEMP_DIR, name)));
        }
      }
      return original(file);
    });
    expect((await read(a)).status).toBe(200);
    expect(seen).toEqual([CSV]);

    const bad = await as(api().post('/api/v1/patient-imports/inspect'), a)
      .attach('file', Buffer.from('no es una tabla'), {
        filename: 'p.xlsx',
        contentType: 'application/octet-stream',
      })
      .expect(400);
    expect((bad.body as ErrorBody).message).toMatch(/extensión/);
    expect(readSlots.active).toBe(0);
    await expectNoNewTempFiles(before);
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
    expect(readSlots.active).toBe(0);
    expect(uploadSlots.active).toBe(0);
    const otherAdmin = await loginAs(
      app,
      d.host,
      (await seedMember(raw, d, ClinicRole.ADMIN)).email,
    );
    expect((await read(d, '/inspect', otherAdmin)).status).toBe(200);
  });
});
