import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import { PrismaPatientImportRepository } from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import type { ImportPatientData } from '../src/modules/patient-imports/domain/import-fields';

// DX-107, capa DB de la importación de pacientes: RLS FORCE de los lotes y sus
// filas, FK compuestas por tenant (paciente → lote, fila → lote/paciente),
// CHECKs, una importación en marcha por clínica, nunca dos pacientes vivos
// con el mismo documento (contra la BD y dentro del lote) y el deshacer.
// Todo por la ruta de la app (runWithTenant, rol dentalix_app); `raw`
// (DIRECT_URL) solo siembra, lee y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientImportRepository(prisma, tenantContext);

const SUBDOMAINS = ['imports-int-a', 'imports-int-b'];

interface Seeded {
  tenantId: string;
  locationId: string;
  userId: string;
}

async function purge(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.appointment.deleteMany({ where });
    await raw.patientDentitionEvent.deleteMany({ where });
    await raw.patientAgreement.deleteMany({ where });
    await raw.agreement.deleteMany({ where });
    await raw.payer.deleteMany({ where });
    await raw.job.deleteMany({ where });
    await raw.patientImportRow.deleteMany({ where });
    await raw.patient.updateMany({ where, data: { importBatchId: null } });
    await raw.patientImportBatch.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `admin@${s}.test`) } },
  });
}

async function seed(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Admin',
    },
  });
  return { tenantId: tenant.id, locationId: location.id, userId: user.id };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const person = (
  doc: string,
  extra: Partial<ImportPatientData> = {},
): ImportPatientData => ({
  docType: 'CC',
  docNumber: doc,
  firstName: 'Ana',
  lastName: `Doc ${doc}`,
  ...extra,
});

function batchData(
  s: Seeded,
  extra: Partial<Prisma.PatientImportBatchUncheckedCreateInput> = {},
) {
  return {
    tenantId: s.tenantId,
    createdById: s.userId,
    locationId: s.locationId,
    fileName: 'p.csv',
    fileSha256: sha(String(Math.random())),
    fileFormat: 'CSV' as const,
    fileSizeBytes: 10,
    columnMapping: {},
    totalRows: 1,
    validRows: 1,
    duplicateRows: 0,
    errorRows: 0,
    preparedRows: 1,
    ...extra,
  };
}

const inTenant = <T>(s: Seeded, fn: () => Promise<T>) =>
  tenantContext.run(s.tenantId, fn);

/** Lote VALIDATED por el repositorio (como el dry-run) y confirmado a mano. */
async function prepared(
  s: Seeded,
  rows: ImportPatientData[],
  mode: 'SKIP' | 'FILL_EMPTY' = 'SKIP',
) {
  const batch = await inTenant(s, () =>
    repo.createBatch({
      createdById: s.userId,
      locationId: s.locationId,
      fileName: 'p.csv',
      fileSha256: sha(JSON.stringify(rows) + Math.random()),
      fileFormat: 'CSV',
      fileSizeBytes: 100,
      columnMapping: { columns: {} },
      totalRows: rows.length,
      validRows: rows.length,
      duplicateRows: 0,
      errorRows: 0,
      issues: [],
      rows: rows.map((data, i) => ({ rowNumber: i + 2, data })),
    }),
  );
  return inTenant(s, async () => {
    const confirmed = await repo.confirm(batch.id, {
      mode,
      confirmedById: s.userId,
      validatedAfter: new Date(Date.now() - 3_600_000),
      enqueue: () => Promise.resolve(),
    });
    if (confirmed?.kind !== 'confirmed') throw new Error('no confirmado');
    return repo.start(confirmed.batch.id);
  });
}

async function runAll(s: Seeded, batchId: string): Promise<void> {
  const batch = await inTenant(s, () => repo.findBatch(batchId));
  for (;;) {
    const r = await inTenant(s, () => repo.processChunk(batch!, 2, 'EMAIL'));
    if (r.processed === 0) break;
  }
  await inTenant(s, () => repo.finish(batchId, 'COMPLETED'));
}

describe('patient_import_batches/rows: RLS, FK, CHECKs, único por documento y deshacer (DX-107, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    a = await seed(SUBDOMAINS[0]);
    b = await seed(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('RLS FORCE: una clínica no ve ni escribe lotes ni filas de otra', async () => {
    const batchB = await raw.patientImportBatch.create({ data: batchData(b) });
    await raw.patientImportRow.create({
      data: {
        tenantId: b.tenantId,
        batchId: batchB.id,
        rowNumber: 2,
        data: {},
      },
    });
    const seen = await prisma.runWithTenant(a.tenantId, async (tx) => ({
      batches: await tx.patientImportBatch.count(),
      rows: await tx.patientImportRow.count(),
    }));
    expect(seen).toEqual({ batches: 0, rows: 0 });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImportBatch.create({ data: batchData(b) }),
      ),
    ).rejects.toThrow(/row-level security/);
    const forced = await raw.$queryRaw<
      { relname: string; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname IN ('patient_import_batches', 'patient_import_rows') ORDER BY relname`;
    expect(forced.every((r) => r.relforcerowsecurity)).toBe(true);
  });

  it('FK compuestas: un paciente no puede apuntar al lote de otra clínica, ni un lote a una sede ajena', async () => {
    const batchB = await raw.patientImportBatch.create({ data: batchData(b) });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patient.create({
          data: {
            tenantId: a.tenantId,
            firstName: 'X',
            lastName: 'Y',
            importBatchId: batchB.id,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { locationId: b.locationId }),
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('CHECKs: hash, tamaño, filas y estados coherentes', async () => {
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { fileSha256: 'x'.repeat(64) }),
      }),
    ).rejects.toThrow(/patient_import_batches_file_check/);
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { fileSizeBytes: 6 * 1024 * 1024 }),
      }),
    ).rejects.toThrow(/patient_import_batches_file_check/);
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { totalRows: 10_001 }),
      }),
    ).rejects.toThrow(/patient_import_batches_totals_check/);
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { status: 'QUEUED' }),
      }),
    ).rejects.toThrow(/patient_import_batches_confirmed_check/);
  });

  it('una sola importación en cola o en curso por clínica (índice único parcial)', async () => {
    const confirmed = {
      status: 'QUEUED' as const,
      duplicateMode: 'SKIP' as const,
      confirmedById: a.userId,
      confirmedAt: new Date(),
    };
    const first = await raw.patientImportBatch.create({
      data: batchData(a, confirmed),
    });
    await expect(
      raw.patientImportBatch.create({
        data: batchData(a, { ...confirmed, status: 'RUNNING' }),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Otra clínica sí puede a la vez.
    await raw.patientImportBatch.create({ data: batchData(b, confirmed) });
    await raw.patientImportBatch.update({
      where: { id: first.id },
      data: { status: 'COMPLETED' },
    });
    await raw.patientImportBatch.updateMany({
      where: { tenantId: b.tenantId, status: 'QUEUED' },
      data: { status: 'COMPLETED' },
    });
  });

  it('nunca dos pacientes vivos con el mismo documento: ni contra la BD ni dentro del lote', async () => {
    await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Ya',
        lastName: 'Estaba',
        docNumber: '1.111',
      },
    });
    const batch = await prepared(a, [
      person('1111'),
      person('2222'),
      person('2222'),
      person('3333'),
    ]);
    // Alguien da de alta el 3333 a mano DESPUÉS del dry-run.
    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Manual',
          lastName: 'Alta',
          docNumber: '3333',
        },
      }),
    );
    await runAll(a, batch!.id);
    const docs = await raw.patient.groupBy({
      by: ['docNumber'],
      where: {
        tenantId: a.tenantId,
        deletedAt: null,
        docNumber: { in: ['1.111', '1111', '2222', '3333'] },
      },
      _count: true,
    });
    expect(
      Object.fromEntries(docs.map((d) => [d.docNumber, d._count])),
    ).toEqual({ '1.111': 1, '2222': 1, '3333': 1 });
    const done = await raw.patientImportBatch.findUniqueOrThrow({
      where: { id: batch!.id },
    });
    expect(done).toMatchObject({
      status: 'COMPLETED',
      processedRows: 4,
      createdCount: 1,
      skippedCount: 3,
    });
    const rows = await raw.patientImportRow.findMany({
      where: { batchId: batch!.id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(rows.map((r) => r.outcome)).toEqual([
      'SKIPPED',
      'CREATED',
      'SKIPPED',
      'SKIPPED',
    ]);
    // Los datos de las filas se vacían al procesarlas.
    expect(rows.every((r) => r.data === null)).toBe(true);
  });

  it('«actualizar vacíos» bajo RLS no pisa datos y deshacer revierte solo lo rellenado y retira solo lo creado', async () => {
    const before = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Lleno',
        lastName: 'Parcial',
        docNumber: '4444',
        phone: '3001112222',
      },
    });
    const outsider = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Ajeno',
        lastName: 'Al lote',
        docNumber: '6666',
      },
    });
    const batch = await prepared(
      a,
      [
        person('4444', {
          phone: '3109999999',
          email: 'nuevo@x.com',
          birthDate: '1990-01-01',
        }),
        person('5555'),
      ],
      'FILL_EMPTY',
    );
    await runAll(a, batch!.id);
    const filled = await raw.patient.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(filled).toMatchObject({
      phone: '3001112222',
      email: 'nuevo@x.com',
      firstName: 'Lleno',
    });

    const result = await inTenant(a, () => repo.undo(batch!.id, a.userId));
    expect(result).toEqual({ undoneCreated: 1, undoneFilled: 1 });
    const reverted = await raw.patient.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(reverted).toMatchObject({
      phone: '3001112222',
      email: null,
      birthDate: null,
      deletedAt: null,
    });
    expect(
      await raw.patient.count({
        where: { importBatchId: batch!.id, deletedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: outsider.id } }))
        .deletedAt,
    ).toBeNull();
    // Otra clínica no puede deshacer el lote (no lo ve).
    await expect(
      inTenant(b, () => repo.undo(batch!.id, b.userId)),
    ).rejects.toThrow();
  });

  it('deshacer se niega si un paciente creado por el lote ya tiene una cita', async () => {
    const batch = await prepared(a, [person('7777')]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    const start = new Date(Date.now() + 86_400_000);
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        patientId: created.id,
        providerId: a.userId,
        locationId: a.locationId,
        start,
        end: new Date(start.getTime() + 1_800_000),
      },
    });
    await expect(
      inTenant(a, () => repo.undo(batch!.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: created.id } }))
        .deletedAt,
    ).toBeNull();
  });

  it('rowNumber admite la fila 1.048.576 de Excel (CHECK), no más', async () => {
    const batch = await raw.patientImportBatch.create({ data: batchData(a) });
    await raw.patientImportRow.create({
      data: { tenantId: a.tenantId, batchId: batch.id, rowNumber: 1, data: {} },
    });
    await raw.patientImportRow.create({
      data: {
        tenantId: a.tenantId,
        batchId: batch.id,
        rowNumber: 1_048_576,
        data: {},
      },
    });
    await expect(
      raw.patientImportRow.create({
        data: {
          tenantId: a.tenantId,
          batchId: batch.id,
          rowNumber: 1_048_577,
          data: {},
        },
      }),
    ).rejects.toThrow(/patient_import_rows_row_check/);
  });

  it('deshacer mira TODAS las tablas con FK a pacientes (catálogo): ninguna nueva sin revisar', async () => {
    const refs = await repo.patientReferences();
    // Si este test falla, una tabla nueva apunta a pacientes: el deshacer ya
    // la mira sola; revisa que deba bloquearlo y añádela aquí.
    expect(refs.map((r) => `${r.table}.${r.column}`)).toEqual([
      'appointment_waitlist.patientId',
      'appointments.patientId',
      'clinical_entries.patientId',
      'clinical_entry_addenda.patientId',
      'collection_notes.patientId',
      'data_processing_consents.patientId',
      'medical_history_reviews.patientId',
      'medical_history_versions.patientId',
      'patient_agreements.patientId',
      'patient_consents.patientId',
      'patient_coverages.patientId',
      'patient_dentition_events.patientId',
      'patient_documents.patientId',
      'patient_implants.patientId',
      'patient_responsible_parties.patientId',
      'patient_responsible_parties.responsiblePatientId',
      'patient_retention_actions.patientId',
      'payment_promises.patientId',
      'perio_exams.patientId',
      'post_op_instruction_deliveries.patientId',
      'prescriptions.patientId',
      'reminder_opt_out_links.patientId',
      'tooth_records.patientId',
      'treatment_plans.patientId',
      'waitlist_offers.patientId',
    ]);
    const batch = await prepared(a, [person('8881')]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    await raw.patientDentitionEvent.create({
      data: {
        tenantId: a.tenantId,
        patientId: created.id,
        position: '11',
        dentition: 'PERMANENT',
        reason: 'MANUAL',
        performedById: a.userId,
      },
    });
    await expect(
      inTenant(a, () => repo.undo(batch!.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
  });

  it('deshacer se niega si un importado ya tiene un convenio asignado (DX-105)', async () => {
    const batch = await prepared(a, [person('8882')]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    const payer = await raw.payer.create({
      data: { tenantId: a.tenantId, name: 'Mutua DX-107', type: 'OTRO' },
    });
    const agreement = await raw.agreement.create({
      data: {
        tenantId: a.tenantId,
        name: 'Convenio DX-107',
        payerId: payer.id,
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      },
    });
    await raw.patientAgreement.create({
      data: {
        tenantId: a.tenantId,
        patientId: created.id,
        agreementId: agreement.id,
      },
    });
    await expect(
      inTenant(a, () => repo.undo(batch!.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    const still = await raw.patient.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(still.deletedAt).toBeNull();
  });

  it('alta manual con el mismo documento escrito distinto: 409, también si la importación ya lo creó', async () => {
    const batch = await prepared(a, [person('9.191.919')]);
    await runAll(a, batch!.id);
    const manual = new PrismaPatientRepository(prisma, tenantContext);
    await expect(
      inTenant(a, () =>
        manual.create({
          firstName: 'Otra',
          lastName: 'Alta',
          docType: 'CC',
          docNumber: '9191919',
          sex: 'F',
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Y al revés: la importación no crea otro si el alta manual llegó antes con puntos.
    await inTenant(a, () =>
      manual.create({
        firstName: 'Manual',
        lastName: 'Puntos',
        docType: 'CC',
        docNumber: '7.272.727',
        sex: 'M',
      }),
    );
    const second = await prepared(a, [person('7272727')]);
    await runAll(a, second!.id);
    expect(
      await raw.patient.count({
        where: {
          tenantId: a.tenantId,
          deletedAt: null,
          docNumber: { in: ['7.272.727', '7272727'] },
        },
      }),
    ).toBe(1);
  });

  it('una fila con un error suyo queda FAILED y el resto del lote se importa', async () => {
    const batch = await prepared(a, [
      person('6161'),
      person('6162', { docType: 'NO-EXISTE' as never }),
      person('6163'),
    ]);
    await runAll(a, batch!.id);
    const done = await raw.patientImportBatch.findUniqueOrThrow({
      where: { id: batch!.id },
    });
    expect(done).toMatchObject({
      status: 'COMPLETED',
      processedRows: 3,
      createdCount: 2,
      failedCount: 1,
    });
    const rows = await raw.patientImportRow.findMany({
      where: { batchId: batch!.id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(rows.map((r) => r.outcome)).toEqual([
      'CREATED',
      'FAILED',
      'CREATED',
    ]);
  });

  it('lote atascado (su trabajo murió o no existe) pasa a FAILED y deja de bloquear', async () => {
    const stuck = await prepared(a, [person('5151')]);
    expect(stuck!.status).toBe('RUNNING');
    // Un lote con su trabajo vivo NO se toca.
    const alive = await prepared(b, [person('5252')]);
    await raw.job.create({
      data: {
        name: 'patient-imports.process',
        tenantId: b.tenantId,
        idempotencyKey: `patient-import:${alive!.id}`,
        state: 'RUNNING',
      },
    });
    expect(await inTenant(a, () => repo.reapStuck())).toBe(1);
    expect(await repo.reapStuck(b.tenantId)).toBe(0);
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: stuck!.id },
        })
      ).status,
    ).toBe('FAILED');
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: alive!.id },
        })
      ).status,
    ).toBe('RUNNING');
    expect(await inTenant(a, () => repo.activeBatchId())).toBeNull();
    await raw.patientImportBatch.update({
      where: { id: alive!.id },
      data: { status: 'COMPLETED' },
    });
  });

  it('retención: caducar borra las filas preparadas y vacía los errores; a los 90 días, los de lotes terminados', async () => {
    const issues = [
      { row: 2, column: 'doc', kind: 'ERROR', message: 'x', value: 'CC 123' },
    ];
    const dry = await inTenant(a, () =>
      repo.createBatch({
        createdById: a.userId,
        locationId: a.locationId,
        fileName: 'viejo.csv',
        fileSha256: sha('viejo'),
        fileFormat: 'CSV',
        fileSizeBytes: 10,
        columnMapping: { columns: {} },
        totalRows: 2,
        validRows: 1,
        duplicateRows: 0,
        errorRows: 1,
        issues: issues as never,
        rows: [{ rowNumber: 3, data: person('4141') }],
      }),
    );
    await raw.patientImportBatch.update({
      where: { id: dry.id },
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    expect(
      await repo.expireStale(a.tenantId, new Date(Date.now() - 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
    const expired = await raw.patientImportBatch.findUniqueOrThrow({
      where: { id: dry.id },
    });
    expect(expired).toMatchObject({ status: 'EXPIRED', issues: [] });
    expect(expired.issuesPurgedAt).not.toBeNull();
    expect(
      await raw.patientImportRow.count({ where: { batchId: dry.id } }),
    ).toBe(0);

    const old = await raw.patientImportBatch.create({
      data: batchData(a, {
        status: 'COMPLETED',
        duplicateMode: 'SKIP',
        confirmedById: a.userId,
        confirmedAt: new Date(),
        finishedAt: new Date(Date.now() - 91 * 86_400_000),
        issues,
      }),
    });
    expect(
      await repo.purgeIssues(
        a.tenantId,
        new Date(Date.now() - 90 * 86_400_000),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: old.id },
        })
      ).issues,
    ).toEqual([]);
  });
});
