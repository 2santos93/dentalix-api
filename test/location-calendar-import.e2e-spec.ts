import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BERLIN_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { HOLIDAY_MESSAGES } from '../src/modules/location-calendar/domain/holiday-rules';

// DX-316 (G1.5): importar festivos de un CSV o un ICS. La vista previa
// clasifica sin escribir; importar escribe solo las filas NEW, en una
// transacción con el calendario de la sede bloqueado, y se audita una vez con
// los recuentos. El mismo fichero dos veces (o el mismo calendario exportado
// por otra herramienta) no duplica nada (R7).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const FIXTURES = join(
  __dirname,
  '..',
  'src',
  'modules',
  'location-calendar',
  'domain',
  '__fixtures__',
);
const ICS_A = readFileSync(join(FIXTURES, 'holidays-12.ics'));
const ICS_B = readFileSync(join(FIXTURES, 'holidays-12-other-tool.ics'));
const NAMES_A = Array.from(
  { length: 12 },
  (_, i) => `Festivo de prueba ${String(i + 1).padStart(2, '0')}`,
);

interface Holiday {
  id: string;
  date: string;
  name: string;
  recurring: boolean;
}
interface ImportRow {
  line: number;
  date: string | null;
  name: string | null;
  recurring: boolean | null;
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  message: string | null;
  relatedLines: number[];
}
interface ImportResult {
  format: 'CSV' | 'ICS';
  dryRun: boolean;
  counts: { new: number; duplicate: number; error: number };
  rows: ImportRow[];
}

const csv = (...lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');
const message = (res: request.Response): unknown =>
  (res.body as { message: unknown }).message;

describe('Calendario de la sede: importar festivos (e2e, DX-316)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let dentistToken: string;
  let sedes = 0;

  const server = () => app.getHttpServer();
  const auth = (t: request.Test, token = a.adminToken) =>
    t.set('X-Tenant-Host', a.host).set('Authorization', `Bearer ${token}`);

  /** POST multipart a `…/import` o `…/import/preview`. */
  function upload(
    locationId: string,
    bytes: Buffer | null,
    filename: string,
    opts: { preview?: boolean; field?: string; token?: string } = {},
  ): request.Test {
    const path = `/api/v1/locations/${locationId}/holidays/import${opts.preview ? '/preview' : ''}`;
    const req = auth(request(server()).post(path), opts.token);
    return bytes === null
      ? req.field('nota', 'sin archivo')
      : req.attach(opts.field ?? 'file', bytes, { filename });
  }
  const importFile = (id: string, bytes: Buffer, filename: string) =>
    upload(id, bytes, filename).expect(200);
  const previewFile = (id: string, bytes: Buffer, filename: string) =>
    upload(id, bytes, filename, { preview: true }).expect(200);

  async function newLocation(): Promise<string> {
    sedes += 1;
    const res = await auth(request(server()).post('/api/v1/locations'))
      .send(locationBody(REGIONAL_BERLIN_FIXTURE, { name: `Sede ${sedes}` }))
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addHoliday(
    locationId: string,
    body: { date: string; name: string; recurring?: boolean },
  ): Promise<Holiday> {
    const res = await auth(
      request(server()).post(`/api/v1/locations/${locationId}/holidays`),
    )
      .send(body)
      .expect(201);
    return res.body as Holiday;
  }

  const holidaysOf = async (locationId: string): Promise<Holiday[]> =>
    (
      (
        await auth(
          request(server()).get(`/api/v1/locations/${locationId}/calendar`),
        ).expect(200)
      ).body as { holidays: Holiday[] }
    ).holidays;

  const calendarEvents = (locationId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'LOCATION_CALENDAR',
        resourceId: locationId,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

  /** `n` puntuales vivos sembrados de una vez, días seguidos desde 2030-01-01. */
  const seedOneOffs = (locationId: string, n: number) => raw.$executeRaw`
    INSERT INTO "location_holidays"
      ("id", "tenantId", "locationId", "date", "name", "recurring", "updatedAt")
    SELECT gen_random_uuid(), ${a.tenantId}::uuid, ${locationId}::uuid,
           DATE '2030-01-01' + g, 'Sembrado ' || g, false, now()
      FROM generate_series(0, ${n - 1}::int) AS g`;

  const liveCount = (locationId: string) =>
    raw.locationHoliday.count({ where: { locationId, deletedAt: null } });

  /** Seis puntuales nuevos de 2027. */
  const SIX_NEW = csv(
    'fecha,nombre',
    ...[1, 2, 3, 4, 5, 6].map((d) => `2027-02-0${d},Nuevo ${d}`),
  );

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx316-imp-a');
    const { email } = await seedMember(raw, a, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, a.host, email);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('idempotencia (AC2, R7)', () => {
    it('importing the same 12-holiday ICS twice creates 12 then 0 and the calendar lists 12', async () => {
      const id = await newLocation();
      const first = (await importFile(id, ICS_A, 'festivos.ics'))
        .body as ImportResult;
      expect(first).toMatchObject({
        format: 'ICS',
        dryRun: false,
        counts: { new: 12, duplicate: 0, error: 0 },
      });
      expect(first.rows.every((r) => r.status === 'NEW')).toBe(true);

      const second = (await importFile(id, ICS_A, 'festivos.ics'))
        .body as ImportResult;
      expect(second.counts).toEqual({ new: 0, duplicate: 12, error: 0 });
      expect(second.rows.map((r) => [r.status, r.message])).toEqual(
        NAMES_A.map((name) => ['DUPLICATE', `Ya existe: «${name}».`]),
      );
      expect(await holidaysOf(id)).toHaveLength(12);
    });

    it('the same holidays from another tool (other UIDs, folded lines, BOM, CRLF) are duplicates', async () => {
      const id = await newLocation();
      await importFile(id, ICS_A, 'herramienta-a.ics');
      const res = (await importFile(id, ICS_B, 'herramienta-b.ics'))
        .body as ImportResult;
      expect(res.counts).toEqual({ new: 0, duplicate: 12, error: 0 });
      // No se sobrescribe el nombre: siguen los de la primera herramienta.
      expect((await holidaysOf(id)).map((h) => h.name).sort()).toEqual(NAMES_A);
    });
  });

  describe('vista previa y auditoría', () => {
    it('preview writes nothing and is not audited', async () => {
      const id = await newLocation();
      const res = (await previewFile(id, ICS_A, 'festivos.ics'))
        .body as ImportResult;
      expect(res).toMatchObject({
        format: 'ICS',
        dryRun: true,
        counts: { new: 12, duplicate: 0, error: 0 },
      });
      expect(await holidaysOf(id)).toEqual([]);
      expect(await calendarEvents(id)).toEqual([]);
    });

    it('import is audited once with format and counts', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2027-01-11', name: 'Ya estaba' });
      await importFile(id, ICS_A, 'festivos.ics');
      // Una importación que no crea nada no cambia el calendario: sin evento.
      await importFile(id, ICS_A, 'festivos.ics');

      const events = (await calendarEvents(id)).filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'HOLIDAYS_IMPORTED',
      );
      expect(
        events.map((e) => ({
          action: e.action,
          actorUserId: e.actorUserId,
          metadata: e.metadata,
        })),
      ).toEqual([
        {
          action: 'CREATE',
          actorUserId: a.adminUserId,
          metadata: {
            params: { id },
            reason: 'HOLIDAYS_IMPORTED',
            locationCalendar: {
              import: { format: 'ICS', created: 11, duplicate: 1, error: 0 },
            },
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('Festivo de prueba');
    });
  });

  describe('clasificación (§5.1, R5)', () => {
    const MIXED = [
      'fecha,nombre,recurrente',
      '2027-01-04,Nuevo,no',
      '2027-03-15,Repetido A,',
      '2027-03-15,Repetido B,',
      '03/05/2027,Fecha regional,',
      '2027-11-08,Otro nombre,no',
    ];

    it('CSV with valid, repeated-in-file, read-error and existing rows', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2027-11-08', name: 'Existente' });
      const res = (await importFile(id, csv(...MIXED), 'festivos.csv'))
        .body as ImportResult;
      expect(res).toEqual({
        format: 'CSV',
        dryRun: false,
        counts: { new: 1, duplicate: 1, error: 3 },
        rows: [
          {
            line: 2,
            date: '2027-01-04',
            name: 'Nuevo',
            recurring: false,
            status: 'NEW',
            message: null,
            relatedLines: [],
          },
          {
            line: 3,
            date: '2027-03-15',
            name: 'Repetido A',
            recurring: false,
            status: 'ERROR',
            message: 'La fecha se repite en el archivo.',
            relatedLines: [4],
          },
          {
            line: 4,
            date: '2027-03-15',
            name: 'Repetido B',
            recurring: false,
            status: 'ERROR',
            message: 'La fecha se repite en el archivo.',
            relatedLines: [3],
          },
          {
            line: 5,
            date: null,
            name: 'Fecha regional',
            recurring: false,
            status: 'ERROR',
            message:
              'Fecha «03/05/2027» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.',
            relatedLines: [],
          },
          {
            line: 6,
            date: '2027-11-08',
            name: 'Otro nombre',
            recurring: false,
            status: 'DUPLICATE',
            message: 'Ya existe: «Existente».',
            relatedLines: [],
          },
        ],
      });
      // Solo la fila NEW se escribió; las de error no impiden escribirla.
      expect(
        (await holidaysOf(id)).map((h) => [h.date, h.name]).sort(),
      ).toEqual([
        ['2027-01-04', 'Nuevo'],
        ['2027-11-08', 'Existente'],
      ]);
    });

    it('a one-off on an existing recurring day is ERROR', async () => {
      const id = await newLocation();
      await addHoliday(id, {
        date: '2001-05-03',
        name: 'Cada año',
        recurring: true,
      });
      const res = (
        await importFile(id, csv('fecha,nombre', '2027-05-03,Puntual'), 'f.csv')
      ).body as ImportResult;
      expect(res.rows).toEqual([
        expect.objectContaining({
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.oneOffOnRecurring('Cada año'),
        }),
      ]);
      expect(await holidaysOf(id)).toHaveLength(1);
    });

    it('a recurring row over an existing one-off is ERROR', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2027-06-01', name: 'Puntual' });
      const res = (
        await importFile(
          id,
          csv('fecha,nombre,recurrente', '2030-06-01,Cada año,sí'),
          'f.csv',
        )
      ).body as ImportResult;
      expect(res.rows).toEqual([
        expect.objectContaining({
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.recurringOnOneOff('Puntual'),
        }),
      ]);
      expect(await holidaysOf(id)).toHaveLength(1);
    });

    it('preview gives exactly the rows and counts that the import then gives', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2027-11-08', name: 'Existente' });
      await addHoliday(id, {
        date: '2001-07-20',
        name: 'Cada año',
        recurring: true,
      });
      const file = csv(...MIXED, '2027-07-20,Sobre recurrente,');
      const preview = (await previewFile(id, file, 'f.csv'))
        .body as ImportResult;
      const imported = (await importFile(id, file, 'f.csv'))
        .body as ImportResult;
      expect(preview.dryRun).toBe(true);
      expect(imported).toEqual({ ...preview, dryRun: false });
    });

    it('import order does not change the classification', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2027-11-08', name: 'Existente' });
      await addHoliday(id, {
        date: '2001-07-20',
        name: 'Cada año',
        recurring: true,
      });
      const body = [
        ...MIXED.slice(1),
        '2027-07-20,Sobre recurrente,',
        '2027-09-01,Puntual,',
        '2031-09-01,Recurrente cruzado,sí',
      ];
      const byKey = (r: ImportResult) =>
        r.rows
          .map((row) => `${row.date}|${row.name}|${row.status}|${row.message}`)
          .sort();
      const forward = (await previewFile(id, csv(MIXED[0], ...body), 'f.csv'))
        .body as ImportResult;
      const backward = (
        await previewFile(id, csv(MIXED[0], ...[...body].reverse()), 'f.csv')
      ).body as ImportResult;
      expect(byKey(backward)).toEqual(byKey(forward));
      expect(backward.counts).toEqual(forward.counts);
      expect(forward.counts).toEqual({ new: 1, duplicate: 1, error: 6 });
    });

    it('rows carry relatedLines and the Swagger enum', () => {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const schemas = doc.components?.schemas as Record<
        string,
        { properties: Record<string, Record<string, unknown>> }
      >;
      const row = schemas.HolidayImportRowDto.properties;
      expect(row.status).toMatchObject({ enum: ['NEW', 'DUPLICATE', 'ERROR'] });
      expect(row.relatedLines).toMatchObject({
        type: 'array',
        items: { type: 'number' },
      });
      for (const field of ['date', 'name', 'recurring', 'message']) {
        expect({ field, nullable: row[field].nullable }).toEqual({
          field,
          nullable: true,
        });
      }
      const result = schemas.HolidayImportResultDto.properties;
      expect(result.format).toMatchObject({ enum: ['CSV', 'ICS'] });
      for (const path of [
        '/api/v1/locations/{id}/holidays/import',
        '/api/v1/locations/{id}/holidays/import/preview',
      ]) {
        const post = doc.paths[path].post as {
          responses: Record<string, unknown>;
          requestBody?: { content: Record<string, unknown> };
        };
        expect(Object.keys(post.responses)).toContain('200');
        expect(Object.keys(post.responses)).not.toContain('201');
        expect(Object.keys(post.requestBody?.content ?? {})).toEqual([
          'multipart/form-data',
        ]);
      }
    });
  });

  describe('errores del fichero (§5.1)', () => {
    it('a .txt is 400 «Sube un archivo .csv o .ics.»', async () => {
      const id = await newLocation();
      const res = await upload(id, csv('fecha,nombre'), 'festivos.txt');
      expect(res.status).toBe(400);
      expect(message(res)).toBe('Sube un archivo .csv o .ics.');
    });

    it('an .ics with a CSV inside and a .csv with an ICS inside are 400 for the extension', async () => {
      const id = await newLocation();
      const ics = await upload(
        id,
        csv('fecha,nombre', '2027-01-04,X'),
        'f.ics',
      );
      expect(ics.status).toBe(400);
      expect(message(ics)).toBe(
        'El archivo .ics no tiene el formato que dice su extensión.',
      );
      const csvFile = await upload(id, ICS_B, 'f.CSV');
      expect(csvFile.status).toBe(400);
      expect(message(csvFile)).toBe(
        'El archivo .csv no tiene el formato que dice su extensión.',
      );
      expect(await holidaysOf(id)).toEqual([]);
    });

    it('an empty file is 400 «El archivo está vacío.»', async () => {
      const id = await newLocation();
      for (const name of ['vacio.csv', 'vacio.ics']) {
        const res = await upload(id, Buffer.alloc(0), name);
        expect({ name, status: res.status, message: message(res) }).toEqual({
          name,
          status: 400,
          message: 'El archivo está vacío.',
        });
      }
    });

    it('two file parts are 400 «Solo se admite un archivo por subida.»', async () => {
      const id = await newLocation();
      const res = await auth(
        request(server()).post(
          `/api/v1/locations/${id}/holidays/import/preview`,
        ),
      )
        .attach('file', ICS_A, { filename: 'a.ics' })
        .attach('file', ICS_A, { filename: 'b.ics' });
      expect(res.status).toBe(400);
      expect(message(res)).toBe('Solo se admite un archivo por subida.');
      expect(await holidaysOf(id)).toEqual([]);
    });

    it('no file is 400 «Falta el archivo.»; another field name is the multer text in Spanish', async () => {
      const id = await newLocation();
      const missing = await upload(id, null, 'x.csv');
      expect(missing.status).toBe(400);
      expect(message(missing)).toBe('Falta el archivo.');
      const wrongField = await upload(id, ICS_A, 'f.ics', { field: 'archivo' });
      expect(wrongField.status).toBe(400);
      expect(message(wrongField)).toBe(
        'El archivo debe ir en el campo «file».',
      );
    });

    it('a 257 KB file is 413 «El archivo supera 256 KB.»', async () => {
      const id = await newLocation();
      const big = Buffer.concat([
        csv('fecha,nombre', ''),
        Buffer.alloc(257 * 1024, 'a'),
      ]);
      const res = await upload(id, big, 'grande.csv', { preview: true });
      expect(res.status).toBe(413);
      expect(message(res)).toBe('El archivo supera 256 KB.');
    });

    it('a file with more than 500 entries is 400 with the location format', async () => {
      const id = await newLocation();
      const rows = Array.from(
        { length: 501 },
        (_, i) => `2027-01-01,Fila ${i}`,
      );
      const res = await upload(id, csv('fecha,nombre', ...rows), 'f.csv', {
        preview: true,
      });
      expect(res.status).toBe(400);
      expect(message(res)).toBe(
        'El archivo tiene más de 500 filas o días de festivo: divídelo.',
      );
    });
  });

  describe('tope por sede (§5.1)', () => {
    it('limit per location: with 995 live, a file of 6 new is 409 and nothing is written', async () => {
      const id = await newLocation();
      await seedOneOffs(id, 995);
      const res = await upload(id, SIX_NEW, 'f.csv');
      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe(
        'LOCATION_HOLIDAY_LIMIT',
      );
      expect(await liveCount(id)).toBe(995);
      expect(await calendarEvents(id)).toEqual([]);
      // Cinco caben justo; y un fichero que solo repite no choca con el tope.
      await importFile(
        id,
        csv(
          'fecha,nombre',
          ...[1, 2, 3, 4, 5].map((d) => `2027-02-0${d},Nuevo ${d}`),
        ),
        'f.csv',
      );
      expect(await liveCount(id)).toBe(1000);
      const again = (
        await importFile(
          id,
          SIX_NEW.subarray(0, SIX_NEW.lastIndexOf('\n')),
          'f.csv',
        )
      ).body as ImportResult;
      expect(again.counts).toEqual({ new: 0, duplicate: 5, error: 0 });
    });

    it('limit message uses the location format', async () => {
      const id = await newLocation();
      await seedOneOffs(id, 995);
      // Berlín (de-DE): «1.000». La vista previa avisa igual que importar.
      for (const preview of [true, false]) {
        const res = await upload(id, SIX_NEW, 'f.csv', { preview });
        expect({
          preview,
          status: res.status,
          body: res.body as unknown,
        }).toEqual({
          preview,
          status: 409,
          body: {
            statusCode: 409,
            error: 'Conflict',
            code: 'LOCATION_HOLIDAY_LIMIT',
            message:
              'La sede tendría más de 1.000 festivos. Borra los de años pasados e inténtalo de nuevo.',
          },
        });
      }
    });
  });

  describe('acceso', () => {
    it('DENTIST gets 403', async () => {
      const id = await newLocation();
      for (const preview of [true, false]) {
        const res = await upload(id, ICS_A, 'f.ics', {
          preview,
          token: dentistToken,
        });
        expect({ preview, status: res.status, message: message(res) }).toEqual({
          preview,
          status: 403,
          message: HOLIDAY_MESSAGES.rolesDenied,
        });
      }
      expect(await liveCount(id)).toBe(0);
    });

    it('preview and import answer 200, not 201', async () => {
      const id = await newLocation();
      await upload(id, ICS_A, 'f.ics', { preview: true }).expect(200);
      await upload(id, ICS_A, 'f.ics').expect(200);
    });

    // El caso de otra clínica (B → 404 sin tocar nada de A) está en
    // tenant-isolation-matrix.e2e-spec.ts, en las dos rutas.
    it('a malformed location id is 400 and an unknown location id is 404', async () => {
      const bad = await upload('no-es-un-id', ICS_A, 'f.ics');
      expect(bad.status).toBe(400);
      expect((bad.body as { message: string }).message).toBe(
        HOLIDAY_MESSAGES.invalidLocationId,
      );
      const missing = await upload(
        '6f1e9d1c-8a1b-4f63-9a3c-0c2f4b5d7e81',
        ICS_A,
        'f.ics',
      );
      expect(missing.status).toBe(404);
      expect((missing.body as { code: string }).code).toBe(
        'LOCATION_NOT_FOUND',
      );
    });
  });
});
