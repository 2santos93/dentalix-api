import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { buildXlsx } from '../src/modules/patient-imports/domain/__fixtures__/xlsx-builder';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-107 · Importación de pacientes desde CSV/XLSX en HTTP real: plantilla,
// inspección, dry-run sin escribir, confirmación en segundo plano mientras la
// clínica sigue operando, deduplicación, «actualizar vacíos», deshacer,
// informe de errores con fórmulas neutralizadas, autorización Ley 1581
// pendiente, solo ADMIN, auditoría y aislamiento entre clínicas.
const raw = new PrismaClient({
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
      `CC;${doc};Paciente ${i};Masivo;01/02/1990;F;310${String(i).padStart(7, '0')};p${prefix}${i}@example.com;`,
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
        timezone: 'America/Bogota',
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
        docType: 'CC',
        docNumber: '900900',
        firstName: 'Ya',
        lastName: 'Existía',
        sex: 'UNSPECIFIED',
        phone: '3009999999',
      })
      .expect(201);
    existingId = (existing.body as { id: string }).id;
    await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'TI',
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
    await upload('', csvOf(['CC;1;A;B;;;;;']), 'p.csv', {}, reception).expect(
      403,
    );
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
      csvOf(['CC;1;Ana;Pérez;;;;;']),
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
      'CC;1.000.001;Ana;Nueva;03/05/1990;F;310 123 4567;ana@example.com;', // 2 válida
      'CC;1000002;Luis;Nuevo;;M;;;', // 3 válida
      'CC;1000001;Ana;Repetida;;;;;', // 4 repetida en el archivo
      'CC;900900;Nombre;Distinto;1980-01-01;F;3001111111;ya@example.com;nota', // 5 ya existe
      'CC;700700;Choque;Tipo;;;;;', // 6 mismo nº con otro tipo
      ';;;SinNombre;31/02/1990;Q;abc;=HYPERLINK("http://x");', // 7 errores
      'CC;1000003;Eva;Nueva;;;;;', // 8 válida
    ]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const started = Date.now();
    const res = await upload('', bytes, 'pacientes.csv', {
      defaultDocType: 'CC',
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
    expect(byRow(6)[0].message).toMatch(/registrado como TI/);
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
      csvOf(['CC;1000001;Ana;Nueva;;;;;', 'CC;1000002;Luis;Nuevo;;;;;']),
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
        docType: 'CC',
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
        'CC;2000001;Nuevo;Uno;;;;;',
        'CC;2000002;Nuevo;Dos;;;;;',
        'CC;800800;X;Y;1970-07-07;;3105550000;relleno@example.com;',
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
      csvOf(['CC;2000001;Nuevo;Uno;;;;;']),
      'tercero.csv',
    ).expect(201);
    expect((again.body as Batch).totals.validRows).toBe(1);
  });

  it('XLSX: la primera hoja, con números y fechas de Excel', async () => {
    const book = buildXlsx([
      [
        'Tipo Doc',
        'Cédula',
        'Nombre',
        'Apellidos',
        'Fecha de nacimiento',
        'Celular',
      ],
      ['CC', 3000001, 'Hoja', 'Excel', { date: 32874 }, 3101234567],
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
        docType: 'CC',
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
});
