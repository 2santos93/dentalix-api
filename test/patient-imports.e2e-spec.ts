import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import {
  buildXlsx,
  zip,
} from '../src/modules/patient-imports/domain/__fixtures__/xlsx-builder';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { legacyStoredDocType } from '../src/modules/patients/domain/legacy-doc-type';
import { MISSING_FILE_MESSAGE } from '../src/modules/patient-imports/application/patient-imports.use-cases';

// DX-107 · Importación de pacientes desde CSV/XLSX en HTTP real: plantilla,
// inspección, dry-run sin escribir, confirmación en segundo plano mientras la
// clínica sigue operando, deduplicación, «actualizar vacíos», deshacer,
// informe de errores con fórmulas neutralizadas, autorización de datos
// pendiente, solo ADMIN, auditoría y aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Issue {
  row: number;
  column: string | null;
  kind: string;
  message: string;
  value: string | null;
}

interface Batch {
  id: string;
  status: string;
  fileSha256: string;
  totals: {
    totalRows: number;
    validRows: number;
    duplicateRows: number;
    errorRows: number;
  };
  progress: {
    preparedRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    percent: number;
  };
  issues: Issue[];
  issuesTotal: number;
  preview: {
    rowNumber: number;
    status: string;
    data: Record<string, string>;
  }[];
  canConfirm: boolean;
  canUndo: boolean;
  undoneCreated: number | null;
  undoneFilled: number | null;
}

const HEADER =
  'tipo_documento;numero_documento;nombres;apellidos;fecha_nacimiento;sexo;telefono;email;notas';

function csvOf(lines: string[]): Buffer {
  return Buffer.from(`${HEADER}\n${lines.join('\n')}\n`, 'utf8');
}

function bulkCsv(count: number, prefix: string): Buffer {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const doc = `${prefix}${String(i).padStart(6, '0')}`;
    lines.push(
      `NATIONAL_ID;${doc};Paciente ${i};Masivo;01/02/1990;F;310${String(i).padStart(7, '0')};p${prefix}${i}@example.com;`,
    );
  }
  return csvOf(lines);
}

function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Importación de pacientes — /patient-imports (DX-107, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let existingId: string;
  let firstBatch: Batch;
  let mainLocationId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, clinic: Clinic = a) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  const upload = (
    path: string,
    bytes: Buffer,
    filename: string,
    fields: Record<string, string> = {},
    token = a.adminToken,
    clinic = a,
  ) => {
    let req = as(api().post(`/api/v1/patient-imports${path}`), token, clinic);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', bytes, { filename, contentType: 'text/csv' });
  };

  const getBatch = async (id: string, clinic = a): Promise<Batch> =>
    (
      await as(
        api().get(`/api/v1/patient-imports/${id}`),
        clinic.adminToken,
        clinic,
      ).expect(200)
    ).body as Batch;

  const drain = () => app.get(JobWorker).drain();

  const livePatients = () =>
    raw.patient.count({ where: { tenantId: a.tenantId, deletedAt: null } });

  const auditOf = (resourceId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT_IMPORT_BATCH',
        resourceId,
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx107-e2e');
    b = await registerClinic(app, 'dx107-e2e-otra');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    const locations = await as(
      api().get('/api/v1/locations'),
      a.adminToken,
    ).expect(200);
    mainLocationId = (locations.body as { id: string }[])[0].id;
    await as(api().put('/api/v1/locations/schedule'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 0,
          endMinute: 1440,
        })),
      })
      .expect(200);
    // Paciente que ya existe: nombre y teléfono propios, sin email ni fecha.
    const existing = await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'NATIONAL_ID',
        docNumber: '900900',
        firstName: 'Ya',
        lastName: 'Existía',
        sex: 'UNSPECIFIED',
        phone: '3009999999',
      })
      .expect(201);
    existingId = (existing.body as { id: string }).id;
    await as(api().post('/api/v1/patients'), a.adminToken)
      // DX-327 (R12): otro tipo GENÉRICO; dos códigos que dan el mismo
      // genérico ya no son «otro tipo».
      .send({
        docType: 'PASSPORT',
        docNumber: '700700',
        firstName: 'Otro',
        lastName: 'Tipo',
        sex: 'F',
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('solo ADMIN: recepción recibe 403 en español en todas las rutas', async () => {
    const res = await as(
      api().get('/api/v1/patient-imports/template'),
      reception,
    ).expect(403);
    expect((res.body as { message: string }).message).toMatch(/administrador/);
    await upload(
      '',
      csvOf(['NATIONAL_ID;1;A;B;;;;;']),
      'p.csv',
      {},
      reception,
    ).expect(403);
    await as(api().get('/api/v1/patient-imports'), reception).expect(403);
  });

  it('plantilla CSV descargable con las columnas admitidas', async () => {
    const res = await as(
      api().get('/api/v1/patient-imports/template'),
      a.adminToken,
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /plantilla-pacientes\.csv/,
    );
    expect(res.text).toMatch(
      /^\uFEFF?"tipo_documento","numero_documento","nombres","apellidos"/,
    );
  });

  it('inspect: cabeceras, mapeo sugerido y muestra, sin crear lote', async () => {
    const res = await upload(
      '/inspect',
      csvOf(['NATIONAL_ID;1;Ana;Pérez;;;;;']),
      'pacientes.csv',
    ).expect(200);
    expect(res.body).toMatchObject({
      fileFormat: 'CSV',
      delimiter: ';',
      encoding: 'utf-8',
      totalRows: 1,
      suggestedMapping: {
        docType: 'tipo_documento',
        docNumber: 'numero_documento',
        firstName: 'nombres',
      },
    });
    expect(
      await raw.patientImportBatch.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);
  });

  it('dry-run: totales, duplicados y errores por fila en español SIN escribir pacientes', async () => {
    const before = await livePatients();
    const bytes = csvOf([
      'NATIONAL_ID;1.000.001;Ana;Nueva;03/05/1990;F;310 123 4567;ana@example.com;', // 2 válida
      'NATIONAL_ID;1000002;Luis;Nuevo;;M;;;', // 3 válida
      'NATIONAL_ID;1000001;Ana;Repetida;;;;;', // 4 repetida en el archivo
      'NATIONAL_ID;900900;Nombre;Distinto;1980-01-01;F;3001111111;ya@example.com;nota', // 5 ya existe
      'NATIONAL_ID;700700;Choque;Tipo;;;;;', // 6 mismo nº con otro tipo
      ';;;SinNombre;31/02/1990;Q;abc;=HYPERLINK("http://x");', // 7 errores
      'NATIONAL_ID;1000003;Eva;Nueva;;;;;', // 8 válida
    ]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const started = Date.now();
    const res = await upload('', bytes, 'pacientes.csv', {
      defaultDocType: 'NATIONAL_ID',
    }).expect(201);
    expect(Date.now() - started).toBeLessThan(10_000);
    firstBatch = res.body as Batch;
    expect(firstBatch).toMatchObject({
      status: 'VALIDATED',
      fileSha256: sha,
      totals: { totalRows: 7, validRows: 3, duplicateRows: 2, errorRows: 2 },
      progress: { preparedRows: 4, processedRows: 0 },
      canConfirm: true,
      canUndo: false,
    });
    const byRow = (row: number) =>
      firstBatch.issues.filter((i) => i.row === row);
    expect(byRow(4).map((i) => [i.kind, i.column])).toEqual([
      ['DUPLICATE_FILE', 'numero_documento'],
    ]);
    expect(byRow(4)[0].message).toMatch(/fila 2/);
    expect(byRow(5)).toEqual([
      expect.objectContaining({ kind: 'DUPLICATE_EXISTING' }),
    ]);
    expect(byRow(6).map((i) => i.kind)).toEqual(['ERROR']);
    expect(byRow(6)[0].message).toMatch(/registrado como Pasaporte/);
    expect(byRow(7).map((i) => i.column)).toEqual([
      'nombres',
      'numero_documento',
      'fecha_nacimiento',
      'sexo',
      'telefono',
      'email',
    ]);
    expect(byRow(7).every((i) => i.kind === 'ERROR')).toBe(true);
    expect(firstBatch.preview.map((p) => [p.rowNumber, p.status])).toEqual([
      [2, 'NEW'],
      [3, 'NEW'],
      [5, 'EXISTING'],
      [8, 'NEW'],
    ]);
    expect(firstBatch.preview[0].data).toMatchObject({
      docNumber: '1000001',
      phone: '+573101234567',
    });
    expect(await livePatients()).toBe(before);
    const [event] = await auditOf(firstBatch.id);
    expect(event).toMatchObject({
      action: 'CREATE',
      actorUserId: a.adminUserId,
    });
    expect(event.metadata).toMatchObject({
      reason: 'IMPORT_VALIDATED',
      importBatch: {
        fileSha256: sha,
        rows: 7,
        valid: 3,
        duplicates: 2,
        errors: 2,
      },
    });
  });

  it('errors.csv: fila, columna, motivo y valor con las fórmulas neutralizadas; auditado', async () => {
    const res = await as(
      api().get(`/api/v1/patient-imports/${firstBatch.id}/errors.csv`),
      a.adminToken,
    ).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('"Fila","Columna","Tipo","Motivo","Valor"');
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.text).not.toMatch(/(^|,)"=HYPERLINK/m);
    expect(lines.filter((l) => l.startsWith('7,'))).toHaveLength(6);
    const events = await auditOf(firstBatch.id);
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'EXPORT']);
  });

  // ISOLATION_COVERS: GET /patient-imports/:id
  // ISOLATION_COVERS: GET /patient-imports/:id/errors.csv
  // ISOLATION_COVERS: POST /patient-imports/:id/confirm
  // ISOLATION_COVERS: POST /patient-imports/:id/undo
  it('aislamiento: otra clínica no ve ni confirma el lote (404) ni lo lista', async () => {
    await as(
      api().get(`/api/v1/patient-imports/${firstBatch.id}`),
      b.adminToken,
      b,
    ).expect(404);
    await as(
      api().post(`/api/v1/patient-imports/${firstBatch.id}/confirm`),
      b.adminToken,
      b,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(404);
    await as(
      api().post(`/api/v1/patient-imports/${firstBatch.id}/undo`),
      b.adminToken,
      b,
    ).expect(404);
    await as(
      api().get(`/api/v1/patient-imports/${firstBatch.id}/errors.csv`),
      b.adminToken,
      b,
    ).expect(404);
    const list = await as(
      api().get('/api/v1/patient-imports'),
      b.adminToken,
      b,
    ).expect(200);
    expect((list.body as { total: number }).total).toBe(0);
  });

  it('confirmar «actualizar vacíos»: en segundo plano, sin segundo paciente y sin pisar datos ni inventar consentimientos', async () => {
    const before = await livePatients();
    const confirmed = await as(
      api().post(`/api/v1/patient-imports/${firstBatch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'FILL_EMPTY' })
      .expect(200);
    expect((confirmed.body as Batch).status).toBe('QUEUED');
    // Sin worker no se escribe nada: corre en la cola, no en la petición.
    expect(await livePatients()).toBe(before);
    await as(
      api().post(`/api/v1/patient-imports/${firstBatch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(409);

    await drain();
    const done = await getBatch(firstBatch.id);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      progress: {
        processedRows: 4,
        createdCount: 3,
        updatedCount: 1,
        skippedCount: 0,
        percent: 100,
      },
      canUndo: true,
    });
    expect(await livePatients()).toBe(before + 3);
    expect(
      await raw.patient.count({
        where: { tenantId: a.tenantId, docNumber: '900900', deletedAt: null },
      }),
    ).toBe(1);

    const existing = await raw.patient.findUniqueOrThrow({
      where: { id: existingId },
    });
    expect(existing).toMatchObject({
      firstName: 'Ya',
      lastName: 'Existía',
      phone: '3009999999',
      email: 'ya@example.com',
      sex: 'F',
      notes: 'nota',
      importBatchId: null,
    });
    expect(existing.birthDate?.toISOString().slice(0, 10)).toBe('1980-01-01');

    const imported = await raw.patient.findMany({
      where: { importBatchId: firstBatch.id },
    });
    expect(imported.map((p) => p.docNumber).sort()).toEqual([
      '1000001',
      '1000002',
      '1000003',
    ]);
    expect(
      imported.every(
        (p) =>
          p.dataConsentAccepted === false && p.createdById === a.adminUserId,
      ),
    ).toBe(true);
    expect(
      await raw.dataProcessingConsent.count({
        where: { patientId: { in: imported.map((p) => p.id) } },
      }),
    ).toBe(0);
    const ficha = await as(
      api().get(`/api/v1/patients/${imported[0].id}`),
      a.adminToken,
    ).expect(200);
    expect(ficha.body).toMatchObject({
      dataConsentAccepted: false,
      importBatchId: firstBatch.id,
    });
    const consents = await as(
      api().get(`/api/v1/patients/${imported[0].id}/data-consents`),
      a.adminToken,
    ).expect(200);
    expect(
      (
        consents.body as {
          current: { scope: string; granted: boolean | null }[];
        }
      ).current.every((c) => c.granted === null),
    ).toBe(true);

    const events = await auditOf(firstBatch.id);
    expect(events.find((e) => e.action === 'UPDATE')?.metadata).toMatchObject({
      reason: 'IMPORT_CONFIRMED',
      importBatch: { fileSha256: firstBatch.fileSha256, mode: 'FILL_EMPTY' },
    });
  });

  it('el mismo archivo otra vez: todo son duplicados, nada nuevo que crear', async () => {
    const res = await upload(
      '',
      csvOf([
        'NATIONAL_ID;1000001;Ana;Nueva;;;;;',
        'NATIONAL_ID;1000002;Luis;Nuevo;;;;;',
      ]),
      'otra-vez.csv',
    ).expect(201);
    expect((res.body as Batch).totals).toEqual({
      totalRows: 2,
      validRows: 0,
      duplicateRows: 2,
      errorRows: 0,
    });
  });

  it('deshacer se niega si un paciente del lote ya tiene una cita', async () => {
    const patient = await raw.patient.findFirstOrThrow({
      where: { importBatchId: firstBatch.id, docNumber: '1000001' },
    });
    const day = dayFromNow(7);
    await as(api().post('/api/v1/appointments'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        patientId: patient.id,
        providerId: a.adminUserId,
        start: `${day}T15:00:00.000Z`,
        end: `${day}T15:30:00.000Z`,
        reason: 'Control',
      })
      .expect(201);
    const res = await as(
      api().post(`/api/v1/patient-imports/${firstBatch.id}/undo`),
      a.adminToken,
    ).expect(409);
    expect((res.body as { message: string }).message).toMatch(
      /1 paciente de este lote ya tiene citas/,
    );
    expect(
      await raw.patient.count({
        where: { importBatchId: firstBatch.id, deletedAt: null },
      }),
    ).toBe(3);
  });

  it('deshacer: retira solo lo creado por el lote y revierte lo rellenado que nadie cambió', async () => {
    const victim = await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'NATIONAL_ID',
        docNumber: '800800',
        firstName: 'Para',
        lastName: 'Rellenar',
        sex: 'M',
      })
      .expect(201);
    const victimId = (victim.body as { id: string }).id;
    const dry = await upload(
      '',
      csvOf([
        'NATIONAL_ID;2000001;Nuevo;Uno;;;;;',
        'NATIONAL_ID;2000002;Nuevo;Dos;;;;;',
        'NATIONAL_ID;800800;X;Y;1970-07-07;;3105550000;relleno@example.com;',
      ]),
      'segundo.csv',
    ).expect(201);
    const batch = dry.body as Batch;
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'FILL_EMPTY' })
      .expect(200);
    await drain();
    expect((await getBatch(batch.id)).progress).toMatchObject({
      createdCount: 2,
      updatedCount: 1,
    });
    // Alguien corrige a mano el email rellenado: el deshacer lo respeta.
    await as(api().patch(`/api/v1/patients/${victimId}`), a.adminToken)
      .send({ email: 'corregido@example.com' })
      .expect(200);

    const undone = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/undo`),
      a.adminToken,
    ).expect(200);
    expect(undone.body).toMatchObject({
      status: 'UNDONE',
      undoneCreated: 2,
      undoneFilled: 1,
      canUndo: false,
    });
    expect(
      await raw.patient.count({
        where: { importBatchId: batch.id, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await raw.patient.count({
        where: { importBatchId: batch.id, deletedAt: { not: null } },
      }),
    ).toBe(2);
    const reverted = await raw.patient.findUniqueOrThrow({
      where: { id: victimId },
    });
    expect(reverted).toMatchObject({
      deletedAt: null,
      birthDate: null,
      phone: null,
      email: 'corregido@example.com',
      firstName: 'Para',
    });
    // Lo del primer lote sigue vivo.
    expect(
      await raw.patient.count({
        where: { importBatchId: firstBatch.id, deletedAt: null },
      }),
    ).toBe(3);
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/undo`),
      a.adminToken,
    ).expect(409);
    const del = (await auditOf(batch.id)).find((e) => e.action === 'DELETE');
    expect(del?.metadata).toMatchObject({
      reason: 'IMPORT_UNDONE',
      importBatch: { undoneCreated: 2, undoneFilled: 1 },
    });

    // Tras deshacer, el mismo documento se puede volver a importar.
    const again = await upload(
      '',
      csvOf(['NATIONAL_ID;2000001;Nuevo;Uno;;;;;']),
      'tercero.csv',
    ).expect(201);
    expect((again.body as Batch).totals.validRows).toBe(1);
  });

  it('XLSX: la primera hoja, con números y fechas de Excel', async () => {
    const book = buildXlsx([
      [
        'Tipo Doc',
        'Documento',
        'Nombre',
        'Apellidos',
        'Fecha de nacimiento',
        'Celular',
      ],
      [
        'Documento nacional',
        3000001,
        'Hoja',
        'Excel',
        { date: 32874 },
        3101234567,
      ],
    ]);
    const res = await as(api().post('/api/v1/patient-imports'), a.adminToken)
      .attach('file', book, {
        filename: 'pacientes.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      .expect(201);
    expect((res.body as Batch).totals.validRows).toBe(1);
    expect((res.body as Batch).preview[0].data).toMatchObject({
      docNumber: '3000001',
      birthDate: '1990-01-01',
      phone: '+573101234567',
    });
  });

  it('topes: más de 5 MB → 413 y más de 10.000 filas → 400, en español', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x41);
    const tooBig = await upload('', big, 'grande.csv').expect(413);
    expect((tooBig.body as { message: string }).message).toMatch(/5 MB/);
    const tooMany = await upload('', bulkCsv(10_001, '4'), 'muchas.csv').expect(
      400,
    );
    expect((tooMany.body as { message: string }).message).toMatch(
      /más de 10\.000 filas/,
    );
    const pdf = await upload('', Buffer.from('%PDF-1.7'), 'informe.pdf').expect(
      400,
    );
    expect((pdf.body as { message: string }).message).toMatch(/\.csv o \.xlsx/);
  });

  it('import row limit message at an en-US location reads 10,000 (G1-B)', async () => {
    const before = await raw.location.findUniqueOrThrow({
      where: { id: mainLocationId },
      select: { locale: true, hourCycle: true },
    });
    await raw.location.update({
      where: { id: mainLocationId },
      data: { locale: 'en-US', hourCycle: 'h12' },
    });
    try {
      const tooMany = await upload(
        '',
        bulkCsv(10_001, '6'),
        'muchas.csv',
      ).expect(400);
      expect((tooMany.body as { message: string }).message).toBe(
        'El archivo tiene más de 10,000 filas de pacientes. Divídelo en varios archivos.',
      );
      // Sin reloj: 409 solo porque este texto lleva cifras (I4).
      await raw.location.update({
        where: { id: mainLocationId },
        data: { hourCycle: null },
      });
      const unclocked = await upload(
        '',
        bulkCsv(10_001, '6'),
        'muchas.csv',
      ).expect(409);
      expect(unclocked.body).toMatchObject({
        code: 'LOCATION_LOCALE_REQUIRED',
        locationId: mainLocationId,
      });
    } finally {
      await raw.location.update({
        where: { id: mainLocationId },
        data: before,
      });
    }
  });

  it('10.000 filas: el dry-run tarda menos de 60 s', async () => {
    const started = Date.now();
    const res = await upload('', bulkCsv(10_000, '5'), 'diez-mil.csv').expect(
      201,
    );
    const elapsed = Date.now() - started;
    expect((res.body as Batch).totals).toEqual({
      totalRows: 10_000,
      validRows: 10_000,
      duplicateRows: 0,
      errorRows: 0,
    });
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  it('la clínica sigue operando mientras importa: se crea una cita y un paciente con el lote en curso', async () => {
    const dry = await upload('', bulkCsv(3_000, '6'), 'tres-mil.csv').expect(
      201,
    );
    const batch = dry.body as Batch;
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);

    const running = drain();
    let state = await getBatch(batch.id);
    const deadline = Date.now() + 30_000;
    while (
      !(state.status === 'RUNNING' && state.progress.processedRows > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
      state = await getBatch(batch.id);
    }
    expect(state.status).toBe('RUNNING');

    const day = dayFromNow(8);
    const t0 = Date.now();
    await as(api().post('/api/v1/appointments'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        patientId: existingId,
        providerId: a.adminUserId,
        start: `${day}T14:00:00.000Z`,
        end: `${day}T14:30:00.000Z`,
        reason: 'Durante la importación',
      })
      .expect(201);
    await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'NATIONAL_ID',
        docNumber: '555000111',
        firstName: 'Alta',
        lastName: 'Manual',
        sex: 'F',
      })
      .expect(201);
    const operationsMs = Date.now() - t0;
    const during = await getBatch(batch.id);
    expect(during.progress.processedRows).toBeLessThan(3_000);
    expect(operationsMs).toBeLessThan(5_000);

    await running;
    expect((await getBatch(batch.id)).progress).toMatchObject({
      processedRows: 3_000,
      createdCount: 3_000,
    });
  }, 120_000);

  it('sep=; con un título encima, filas en blanco y 10.000 pacientes: 201 con los números de fila de la hoja', async () => {
    const lines = ['sep=;', 'Listado de pacientes 2026', '', HEADER];
    for (let i = 0; i < 10_000; i += 1) {
      if (i % 1000 === 0) lines.push('');
      lines.push(
        `NATIONAL_ID;9${String(i).padStart(7, '0')};Nombre ${i};Hoja;;;;;`,
      );
    }
    const res = await upload(
      '',
      Buffer.from(lines.join('\n'), 'utf8'),
      'con-titulo.csv',
    ).expect(201);
    const batch = res.body as Batch;
    expect(batch.totals).toEqual({
      totalRows: 10_000,
      validRows: 10_000,
      duplicateRows: 0,
      errorRows: 0,
    });
    // Fila 1 = sep=, 2 = título, 3 = vacía, 4 = cabecera, 5 = vacía, 6 = primer paciente.
    expect(batch.preview[0].rowNumber).toBe(6);
  }, 90_000);

  it('XLSX raro: fila r="20000", número enorme con formato de fecha y fila con celdas de más → 201 con errores de fila, nunca 500', async () => {
    const styles =
      '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const cell = (ref: string, text: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const sheet =
      '<worksheet><sheetData>' +
      `<row r="1">${cell('A1', 'nombres')}${cell('B1', 'apellidos')}${cell('C1', 'numero_documento')}${cell('D1', 'fecha_nacimiento')}</row>` +
      `<row r="20000">${cell('A20000', 'Ana')}${cell('B20000', 'Hoja')}${cell('C20000', '81818181')}<c r="D20000" s="1"><v>1e12</v></c></row>` +
      `<row r="20001">${cell('A20001', 'Luis')}${cell('B20001', 'Hoja')}${cell('C20001', '81818182')}${cell('E20001', 'sobra')}</row>` +
      '</sheetData></worksheet>';
    const book = zip([
      {
        name: 'xl/workbook.xml',
        data: Buffer.from(
          '<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: Buffer.from(
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
      },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
      { name: 'xl/styles.xml', data: Buffer.from(styles) },
    ]);
    const res = await as(api().post('/api/v1/patient-imports'), a.adminToken)
      .field('defaultDocType', 'NATIONAL_ID')
      .attach('file', book, {
        filename: 'raro.xlsx',
        contentType: 'application/octet-stream',
      })
      .expect(201);
    const batch = res.body as Batch;
    expect(batch.totals).toMatchObject({
      totalRows: 2,
      errorRows: 2,
      validRows: 0,
    });
    expect(batch.issues.map((i) => i.row)).toEqual([20000, 20001]);
    expect(batch.issues[0].message).toMatch(
      /Fecha de nacimiento no reconocida|no existe|futura/,
    );
    expect(batch.issues[1].message).toMatch(/más celdas que la cabecera/);
  });

  it('el informe de un dry-run caducado ya no está: 410 en español', async () => {
    const first = (await upload('', bulkCsv(3, '3'), 'uno.csv').expect(201))
      .body as Batch;
    const second = (await upload('', bulkCsv(3, '2'), 'dos.csv').expect(201))
      .body as Batch & { reportAvailable: boolean };
    expect(second.reportAvailable).toBe(true);
    // La pantalla oculta «Informe» si ya no existe (revisión, menor 3).
    const expired = await as(
      api().get(`/api/v1/patient-imports/${first.id}`),
      a.adminToken,
    ).expect(200);
    expect(expired.body).toMatchObject({
      status: 'EXPIRED',
      reportAvailable: false,
    });
    const gone = await as(
      api().get(`/api/v1/patient-imports/${first.id}/errors.csv`),
      a.adminToken,
    ).expect(410);
    expect((gone.body as { message: string }).message).toMatch(
      /ya no está disponible/,
    );
    await as(
      api().post(`/api/v1/patient-imports/${first.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(409);
  });

  it('una sola importación en curso por clínica', async () => {
    const one = (await upload('', bulkCsv(5, '7'), 'uno.csv').expect(201))
      .body as Batch;
    const otherAdmin = await seedMember(raw, a, ClinicRole.ADMIN);
    const token = await loginAs(app, a.host, otherAdmin.email);
    const two = (
      await upload('', bulkCsv(5, '8'), 'dos.csv', {}, token).expect(201)
    ).body as Batch;
    await as(
      api().post(`/api/v1/patient-imports/${one.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    const res = await as(
      api().post(`/api/v1/patient-imports/${two.id}/confirm`),
      token,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(409);
    expect((res.body as { message: string }).message).toMatch(/en curso/);
    await drain();
    await as(api().post(`/api/v1/patient-imports/${two.id}/confirm`), token)
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    const list = await as(
      api().get('/api/v1/patient-imports'),
      a.adminToken,
    ).expect(200);
    const items = (list.body as { items: Batch[] }).items;
    expect(items.map((i) => i.status)).not.toContain('VALIDATED');
    expect(items[0].id).toBe(two.id);
  });
  it('DX-287: el documento ya guardado con otro formato es duplicado en el dry-run y al importar, y el alta manual da 409', async () => {
    const create = (docType: string, docNumber: string) =>
      as(api().post('/api/v1/patients'), b.adminToken, b).send({
        docType,
        docNumber,
        firstName: 'Manual',
        lastName: docNumber,
        sex: 'F',
      });
    await create('NATIONAL_ID', '55.123.456').expect(201);
    await create('PASSPORT', 'ab 12 345').expect(201);
    const dry = (
      await upload(
        '',
        csvOf([
          'NATIONAL_ID;55123456;Ana;Mismo;;;;;', // 2: «55.123.456» ya existe
          'PASAPORTE;AB-12345;Bea;Mismo;;;;;', // 3: «ab 12 345» ya existe
          'NATIONAL_ID;66.000.001;Nuevo;Paciente;;;;;', // 4: nuevo
        ]),
        'formatos.csv',
        {},
        b.adminToken,
        b,
      ).expect(201)
    ).body as Batch;
    expect(dry.totals).toEqual({
      totalRows: 3,
      validRows: 1,
      duplicateRows: 2,
      errorRows: 0,
    });
    expect(dry.preview.map((p) => [p.rowNumber, p.status])).toEqual([
      [2, 'EXISTING'],
      [3, 'EXISTING'],
      [4, 'NEW'],
    ]);
    await as(
      api().post(`/api/v1/patient-imports/${dry.id}/confirm`),
      b.adminToken,
      b,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    expect((await getBatch(dry.id, b)).progress).toMatchObject({
      processedRows: 3,
      createdCount: 1,
      skippedCount: 2,
    });
    // Un paciente vivo por clave, y la clave la guardó la BD (trigger).
    const keys = await raw.$queryRaw<{ docKey: string; n: number }[]>`
      SELECT "docKey", count(*)::int AS n FROM "patients"
       WHERE "tenantId" = ${b.tenantId}::uuid AND "deletedAt" IS NULL
         AND "docKey" IN ('55123456', 'AB12345', '66000001')
       GROUP BY "docKey" ORDER BY "docKey"`;
    expect(keys).toEqual([
      { docKey: '55123456', n: 1 },
      { docKey: '66000001', n: 1 },
      { docKey: 'AB12345', n: 1 },
    ]);
    // Y el alta manual con el formato del archivo (o al revés) no duplica.
    await create('NATIONAL_ID', '55-123-456').expect(409);
    await create('NATIONAL_ID', '66000001').expect(409);
  });

  // ---------------------------------------------------------------------
  // DX-327: tipos de documento genéricos. Números ficticios (`RX-…`) o los
  // formatos de R15 cuando el caso es justo ese formato.
  // ---------------------------------------------------------------------

  const importAndDrain = async (
    bytes: Buffer,
    name: string,
    clinic: Clinic = a,
  ): Promise<Batch> => {
    const dry = (
      await upload('', bytes, name, {}, clinic.adminToken, clinic).expect(201)
    ).body as Batch;
    await as(
      api().post(`/api/v1/patient-imports/${dry.id}/confirm`),
      clinic.adminToken,
      clinic,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    return dry;
  };

  const docColumns = (importBatchId: string) =>
    raw.$queryRaw<
      {
        docNumber: string;
        documentType: string;
        docType: string;
        docTypeLabel: string | null;
      }[]
    >`
      SELECT "docNumber", "documentType"::text AS "documentType",
             "docType"::text AS "docType", "docTypeLabel"
        FROM "patients"
       WHERE "import_batch_id" = ${importBatchId}::uuid
       ORDER BY "docNumber"`;

  it('a file with generic types imports every type and its legacy projection is stored', async () => {
    const bytes = csvOf([
      'NATIONAL_ID;RX-5001;Uno;Genérico;;;;;',
      'Pasaporte;RX-5002;Dos;Genérico;;;;;',
      'Permiso de residencia;RX-5003;Tres;Genérico;;;;;',
      'Identificación fiscal;RX-5004;Cuatro;Genérico;;;;;',
      'Otro documento;RX-5005;Cinco;Genérico;;;;;',
    ]);
    const dry = (await upload('', bytes, 'genericos.csv').expect(201))
      .body as Batch;
    expect(dry.issues).toEqual([]);
    expect(dry.preview.map((p) => p.data.docType)).toEqual([
      'NATIONAL_ID',
      'PASSPORT',
      'RESIDENCE_PERMIT',
      'TAX_ID',
      'OTHER',
    ]);
    // Filas preparadas de la fase 1: el código anterior para un worker
    // anterior, el genérico para el nuevo, y ninguna etiqueta.
    const rows = await raw.patientImportRow.findMany({
      where: { batchId: dry.id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(
      rows.map((r) => {
        const data = r.data as Record<string, unknown>;
        return [data.docType, data.documentType, 'docTypeLabel' in data];
      }),
    ).toEqual([
      ['CC', 'NATIONAL_ID', false],
      ['PASSPORT', 'PASSPORT', false],
      ['CE', 'RESIDENCE_PERMIT', false],
      ['OTHER', 'TAX_ID', false],
      ['OTHER', 'OTHER', false],
    ]);
    await as(
      api().post(`/api/v1/patient-imports/${dry.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    expect(await docColumns(dry.id)).toEqual([
      {
        docNumber: 'RX5001',
        documentType: 'NATIONAL_ID',
        docType: legacyStoredDocType('NATIONAL_ID'),
        docTypeLabel: null,
      },
      {
        docNumber: 'RX5002',
        documentType: 'PASSPORT',
        docType: 'PASSPORT',
        docTypeLabel: null,
      },
      {
        docNumber: 'RX5003',
        documentType: 'RESIDENCE_PERMIT',
        docType: legacyStoredDocType('RESIDENCE_PERMIT'),
        docTypeLabel: null,
      },
      {
        docNumber: 'RX5004',
        documentType: 'TAX_ID',
        docType: 'OTHER',
        docTypeLabel: null,
      },
      {
        docNumber: 'RX5005',
        documentType: 'OTHER',
        docType: 'OTHER',
        docTypeLabel: null,
      },
    ]);
  });

  it('legacy file with CC and cédula rows imports NATIONAL_ID with no label', async () => {
    const dry = await importAndDrain(
      csvOf([
        'CC;RX-6001;Uno;Anterior;;;;;',
        'cédula;RX-6002;Dos;Anterior;;;;;',
        'TI;RX-6003;Tres;Anterior;;;;;',
        'Extranjería;RX-6004;Cuatro;Anterior;;;;;',
      ]),
      'anterior.csv',
    );
    expect(dry.issues).toEqual([]);
    expect(
      (await docColumns(dry.id)).map((p) => [p.documentType, p.docTypeLabel]),
    ).toEqual([
      ['NATIONAL_ID', null],
      ['NATIONAL_ID', null],
      ['NATIONAL_ID', null],
      ['RESIDENCE_PERMIT', null],
    ]);
  });

  it('a file with letter-prefixed national numbers imports without errors', async () => {
    const dry = await importAndDrain(
      csvOf([
        'Documento nacional;V-12.345.678;Uno;Prefijo;;;;;',
        'Documento nacional;E-81234567;Dos;Prefijo;;;;;',
        'Identificación fiscal;J-12345678-9;Tres;Prefijo;;;;;',
      ]),
      'prefijos.csv',
    );
    expect(dry.totals).toMatchObject({ validRows: 3, errorRows: 0 });
    expect(dry.issues).toEqual([]);
    expect(
      (await docColumns(dry.id)).map((p) => [
        p.docNumber,
        p.documentType,
        p.docTypeLabel,
      ]),
    ).toEqual([
      ['E81234567', 'NATIONAL_ID', null],
      ['J123456789', 'TAX_ID', null],
      ['V12345678', 'NATIONAL_ID', null],
    ]);
  });

  it('a pending legacy row from an older API is imported with its generic type', async () => {
    const dry = (
      await upload(
        '',
        csvOf(['OTHER;RX-7001;Fila;Anterior;;;;;']),
        'anterior-pendiente.csv',
      ).expect(201)
    ).body as Batch;
    // La fila como la escribía la API anterior: solo el código, sin el
    // genérico (ni etiqueta).
    await raw.$executeRaw`
      UPDATE "patient_import_rows"
         SET "data" = '{"docType":"TI","docNumber":"RX7001","firstName":"Fila","lastName":"Anterior"}'::jsonb
       WHERE "batchId" = ${dry.id}::uuid`;
    await as(
      api().post(`/api/v1/patient-imports/${dry.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    expect((await getBatch(dry.id)).progress).toMatchObject({
      createdCount: 1,
    });
    expect(await docColumns(dry.id)).toEqual([
      {
        docNumber: 'RX7001',
        documentType: 'NATIONAL_ID',
        docType: legacyStoredDocType('NATIONAL_ID'),
        docTypeLabel: null,
      },
    ]);
  });

  it('the template carries generic types and no legacy code', async () => {
    const res = await as(
      api().get('/api/v1/patient-imports/template'),
      a.adminToken,
    ).expect(200);
    const [, first, second] = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(first).toMatch(/^"NATIONAL_ID","DOC-1000001",/);
    expect(second).toMatch(/^"PASSPORT","X1000002",/);
    expect(res.text).not.toMatch(/"(CC|TI|CE)"/);
    // Se vuelve a leer sin errores (salvo que son de ejemplo).
    const dry = (await upload('', Buffer.from(res.text), 'plantilla.csv'))
      .body as Batch;
    expect(dry.issues.filter((i) => i.kind === 'ERROR')).toEqual([]);
  });

  it('OpenAPI publishes only the generic types for the import', () => {
    const swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const schemas = swagger.components?.schemas ?? {};
    const generic = [
      'NATIONAL_ID',
      'PASSPORT',
      'RESIDENCE_PERMIT',
      'TAX_ID',
      'OTHER',
    ];
    expect((schemas.DocType as { enum?: string[] }).enum).toEqual(generic);
    const body = swagger.paths['/api/v1/patient-imports']?.post
      ?.requestBody as {
      content: Record<
        string,
        { schema: { properties: Record<string, { enum?: string[] }> } }
      >;
    };
    expect(
      body.content['multipart/form-data'].schema.properties.defaultDocType.enum,
    ).toEqual(generic);
    expect(
      JSON.stringify(swagger.paths['/api/v1/patient-imports']),
    ).not.toMatch(/"(CC|TI|CE)"|C[ée]dula/);
  });

  it('a JSON defaultDocType null counts as absent: 400, never 500', async () => {
    const res = await as(api().post('/api/v1/patient-imports'), a.adminToken)
      .send({ defaultDocType: null })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      MISSING_FILE_MESSAGE,
    );
  });

  it("an import recognizes this clinic's local names and not another clinic's", async () => {
    const NAMES = '/api/v1/patients/document-type-names';
    const none = {
      NATIONAL_ID: null,
      PASSPORT: null,
      RESIDENCE_PERMIT: null,
      TAX_ID: null,
      OTHER: null,
    };
    await as(api().put(NAMES), a.adminToken)
      .send({ names: { ...none, NATIONAL_ID: 'Documento A' } })
      .expect(200);
    try {
      const bytes = csvOf(['documento a;RX-8001;Nombre;Local;;;;;']);
      const inB = (
        await upload('', bytes, 'local.csv', {}, b.adminToken, b).expect(201)
      ).body as Batch;
      expect(inB.totals).toMatchObject({ validRows: 0, errorRows: 1 });
      expect(inB.issues[0].message).toMatch(
        /^Tipo de documento no reconocido.*\)\.$/,
      );
      expect(inB.issues[0].message).not.toContain('Documento A');
      const inA = await importAndDrain(bytes, 'local.csv');
      expect(inA.issues).toEqual([]);
      expect(await docColumns(inA.id)).toEqual([
        {
          docNumber: 'RX8001',
          documentType: 'NATIONAL_ID',
          docType: legacyStoredDocType('NATIONAL_ID'),
          docTypeLabel: null,
        },
      ]);
      // Un tipo desconocido en A lista también sus nombres locales.
      const unknown = (
        await upload('', csvOf(['ZZ;RX-8002;Otro;Local;;;;;']), 'zz.csv')
      ).body as Batch;
      expect(unknown.issues[0].message).toMatch(
        /, o uno de los nombres de tu clínica: Documento A\.$/,
      );
    } finally {
      await as(api().put(NAMES), a.adminToken)
        .send({ names: none })
        .expect(200);
    }
  });

  it('an import in a VE location stores +58 numbers', async () => {
    const before = await raw.location.findUniqueOrThrow({
      where: { id: mainLocationId },
      select: { country: true, defaultPhoneRegion: true },
    });
    // DX-329 (pre-flight I2): el país ya no da el prefijo; lo da la región.
    await raw.location.update({
      where: { id: mainLocationId },
      data: { country: 'VE', defaultPhoneRegion: 'VE' },
    });
    try {
      const dry = await importAndDrain(
        csvOf(['NATIONAL_ID;312001;Vera;Indicativo;;F;0412-1234567;;']),
        've.csv',
      );
      expect(dry.issues).toEqual([]);
      expect(dry.preview[0].data.phone).toBe('+584121234567');
      const stored = await raw.patient.findFirstOrThrow({
        where: { tenantId: a.tenantId, docNumber: '312001' },
        select: { phone: true },
      });
      expect(stored.phone).toBe('+584121234567');
    } finally {
      await raw.location.update({
        where: { id: mainLocationId },
        data: before,
      });
    }
  });

  it('an import with region IT keeps the leading zero of a landline', async () => {
    const before = await raw.location.findUniqueOrThrow({
      where: { id: mainLocationId },
      select: { defaultPhoneRegion: true },
    });
    await raw.location.update({
      where: { id: mainLocationId },
      data: { defaultPhoneRegion: 'IT' },
    });
    try {
      const dry = await importAndDrain(
        csvOf(['NATIONAL_ID;329001;Ilaria;Indicativo;;F;06 1234 5678;;']),
        'it.csv',
      );
      expect(dry.issues).toEqual([]);
      expect(dry.preview[0].data.phone).toBe('+390612345678');
      const stored = await raw.patient.findFirstOrThrow({
        where: { tenantId: a.tenantId, docNumber: '329001' },
        select: { phone: true },
      });
      expect(stored.phone).toBe('+390612345678');
    } finally {
      await raw.location.update({
        where: { id: mainLocationId },
        data: before,
      });
    }
  });
});
