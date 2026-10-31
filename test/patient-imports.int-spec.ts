import { PrismaReminderOptOutRepository } from '../src/modules/reminders/infrastructure/prisma-reminder-opt-out.repository';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import {
  BatchNotRunningError,
  PrismaPatientImportRepository,
} from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import type { ImportPatientData } from '../src/modules/patient-imports/domain/import-fields';
import { ANESTHESIA_DOSE_RULES_VERSION } from '../src/modules/anesthesia/domain/anesthesia-dose';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-107, capa DB de la importación de pacientes: RLS FORCE de los lotes y sus
// filas, FK compuestas por tenant (paciente → lote, fila → lote/paciente),
// CHECKs, una importación en marcha por clínica, nunca dos pacientes vivos
// con el mismo documento (contra la BD y dentro del lote) y el deshacer.
// Todo por la ruta de la app (runWithTenant, rol dentalix_app); `raw`
// (DIRECT_URL) solo siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
    // DX-214: aviso append-only; limpieza solo con conexión administrativa.
    await raw.reminderOptOutMatchWarning.deleteMany({ where });
    // DX-307/DX-412: anestesia y evolución, append-only como el aviso.
    await raw.anesthesiaAdministration.deleteMany({ where });
    await raw.anestheticProduct.deleteMany({ where });
    await raw.clinicalEntry.deleteMany({ where });
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
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
    }),
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
  docType: 'NATIONAL_ID',
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
        // Sin el trigger de DX-327, la columna toma su DEFAULT 'OTHER'.
        documentType: 'NATIONAL_ID',
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
    expect(result).toEqual({
      undoneCreated: 1,
      undoneFilled: 1,
      undoneBalances: 0,
    });
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
      // DX-307/DX-412: la anestesia registrada es historia clínica: bloquea.
      'anesthesia_administrations.patientId',
      'appointment_waitlist.patientId',
      'appointments.patientId',
      'clinical_entries.patientId',
      'clinical_entry_addenda.patientId',
      'collection_notes.patientId',
      'data_processing_consents.patientId',
      'medical_history_reviews.patientId',
      // DX-099: una anamnesis enviada por enlace también bloquea el deshacer.
      'medical_history_submissions.patientId',
      'medical_history_versions.patientId',
      'patient_agreements.patientId',
      // DX-243: la firma del profesional de uno firmado a distancia.
      'patient_consent_countersignatures.patientId',
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
      // DX-214: el aviso auditable es actividad durable y debe bloquear undo.
      'reminder_opt_out_match_warnings.patientId',
      // DX-407: la hoja de sedación cuelga de una evolución, como la anestesia.
      'sedation_records.patientId',
      // DX-243: un consentimiento enviado a firmar a distancia bloquea el deshacer.
      'signature_requests.patientId',
      // DX-422: el estado del PDF firmado; solo existe con un consentimiento
      // firmado (que ya bloquea el deshacer): bloquea igual.
      'signed_consent_pdfs.patientId',
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

  it('DX-412: la anestesia registrada (DX-307) bloquea deshacer el lote como el resto de la historia clínica, sin tocar nada', async () => {
    const batch = await prepared(a, [person('8885')]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    const product = await raw.anestheticProduct.create({
      data: {
        tenantId: a.tenantId,
        name: 'Lidocaína 2 % con epinefrina',
        activeIngredient: 'lidocaína',
        concentrationPct: 2,
        vasoconstrictor: 'epinefrina 1:100.000',
        mlPerCarpule: 1.8,
        maxMgPerKg: 7,
        maxAbsoluteMg: 500,
      },
    });
    const entry = await raw.clinicalEntry.create({
      data: {
        tenantId: a.tenantId,
        patientId: created.id,
        locationId: a.locationId,
        entryDate: new Date(),
        notes: 'Exodoncia 48',
        performedById: a.userId,
      },
    });
    const anesthesia = await raw.anesthesiaAdministration.create({
      data: {
        tenantId: a.tenantId,
        patientId: created.id,
        clinicalEntryId: entry.id,
        locationId: a.locationId,
        anestheticId: product.id,
        anestheticName: product.name,
        activeIngredient: product.activeIngredient,
        concentrationPct: product.concentrationPct,
        vasoconstrictor: product.vasoconstrictor,
        mlPerCarpule: product.mlPerCarpule,
        maxMgPerKg: product.maxMgPerKg,
        maxAbsoluteMg: product.maxAbsoluteMg,
        carpules: 2,
        doseMg: 72,
        technique: 'NERVE_BLOCK',
        administeredAt: new Date(),
        weightKg: 70,
        weightSource: 'ENTERED',
        cumulativeMg: 72,
        cumulativePercent: 15,
        safetyRulesVersion: ANESTHESIA_DOSE_RULES_VERSION,
        safetyAlerts: [],
        authorId: a.userId,
      },
    });

    // La revisión del deshacer corre como la app (RLS FORCE, sin DELETE en
    // la tabla) y cuenta al paciente una sola vez aunque tenga evolución y
    // anestesia.
    await expect(
      inTenant(a, () => repo.undo(batch!.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: created.id } }))
        .deletedAt,
    ).toBeNull();
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: batch!.id },
        })
      ).status,
    ).toBe('COMPLETED');
    await expect(
      raw.anesthesiaAdministration.findUniqueOrThrow({
        where: { id: anesthesia.id },
      }),
    ).resolves.toMatchObject({
      patientId: created.id,
      clinicalEntryId: entry.id,
    });
    // Otra clínica no ve esa anestesia (RLS) ni puede deshacer el lote.
    await expect(
      inTenant(b, () =>
        prisma.runWithTenant((tx) =>
          tx.anesthesiaAdministration.count({
            where: { patientId: created.id },
          }),
        ),
      ),
    ).resolves.toBe(0);
    await expect(
      inTenant(b, () => repo.undo(batch!.id, b.userId)),
    ).rejects.toThrow();
  });

  it('DX-214: un aviso durable bloquea deshacer el lote y conserva paciente, filas y avisos bajo RLS', async () => {
    const batch = await prepared(a, [person('8883', { phone: '3101234567' })]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    const warnings = new PrismaReminderOptOutRepository(prisma, tenantContext);
    await inTenant(a, () => warnings.recordMatchWarnings([created.id], 6, 5));
    const snapshot = async () => {
      const [patient, imported, rows, notices] = await Promise.all([
        raw.patient.findUniqueOrThrow({ where: { id: created.id } }),
        raw.patientImportBatch.findUniqueOrThrow({ where: { id: batch!.id } }),
        raw.patientImportRow.findMany({
          where: { batchId: batch!.id },
          orderBy: { rowNumber: 'asc' },
        }),
        raw.reminderOptOutMatchWarning.findMany({
          where: { patientId: created.id },
          orderBy: { id: 'asc' },
        }),
      ]);
      return { patient, imported, rows, notices };
    };
    const before = await snapshot();
    expect(before.notices).toHaveLength(1);
    expect(before.patient.deletedAt).toBeNull();
    expect(before.imported.status).toBe('COMPLETED');
    expect(before.rows[0]).toMatchObject({
      patientId: created.id,
      outcome: 'CREATED',
    });
    await expect(
      inTenant(b, () =>
        prisma.runWithTenant((tx) =>
          tx.reminderOptOutMatchWarning.findMany({
            where: { patientId: created.id },
          }),
        ),
      ),
    ).resolves.toEqual([]);
    await expect(
      inTenant(b, () => repo.undo(batch!.id, b.userId)),
    ).rejects.toThrow();
    await expect(
      inTenant(a, () => repo.undo(batch!.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    expect(await snapshot()).toEqual(before);
  });

  it('deshacer se niega si un importado ya tiene un convenio asignado (DX-105)', async () => {
    const batch = await prepared(a, [person('8882')]);
    await runAll(a, batch!.id);
    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch!.id },
    });
    const payer = await raw.payer.create({
      data: { tenantId: a.tenantId, name: 'Mutua DX-107', type: 'OTHER' },
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
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
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
        docType: 'NATIONAL_ID',
        docTypeLabel: null,
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
      { row: 2, column: 'doc', kind: 'ERROR', message: 'x', value: 'RX-123' },
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

  it('«actualizar vacíos» no rellena los datos suprimidos de un paciente (DX-039) y el dry-run lo avisa (revisión I2)', async () => {
    const suppressed = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Suprimido',
        lastName: 'Parcial',
        // Sin el trigger de DX-327, la columna toma su DEFAULT 'OTHER'.
        documentType: 'NATIONAL_ID',
        docNumber: '8181',
        partiallySuppressedAt: new Date(),
      },
    });
    const docs = await inTenant(a, () => repo.existingDocs(['8181']));
    expect(docs).toEqual([
      expect.objectContaining({ id: suppressed.id, partiallySuppressed: true }),
    ]);
    const batch = await prepared(
      a,
      [
        person('8181', {
          phone: '+573109999999',
          email: 'viejo@x.com',
          address: 'Calle vieja',
          notes: 'nota vieja',
          emergencyContactName: 'Luis',
          emergencyContactPhone: '+573108888888',
          birthDate: '1980-05-05',
        }),
      ],
      'FILL_EMPTY',
    );
    await runAll(a, batch!.id);
    const after = await raw.patient.findUniqueOrThrow({
      where: { id: suppressed.id },
    });
    expect(after).toMatchObject({
      phone: null,
      email: null,
      address: null,
      notes: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
    expect(after.birthDate?.toISOString().slice(0, 10)).toBe('1980-05-05');
    const row = await raw.patientImportRow.findFirstOrThrow({
      where: { batchId: batch!.id },
    });
    expect(JSON.stringify(row.filledValues)).not.toMatch(
      /viejo@x\.com|3109999999|Calle vieja|nota vieja|Luis|3108888888/,
    );
  });

  it('existingDocsSql and the chunk lookup read documentType', async () => {
    // DX-327: un TAX_ID tiene OTHER en la columna anterior. El dry-run y el
    // bloque comparan el genérico (y el dry-run lee la etiqueta, que es su
    // nombre visible); con la columna anterior, TAX_ID ≠ OTHER y no se
    // rellenaría.
    const existing = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Fiscal',
        lastName: 'Genérico',
        docNumber: 'RX-9191',
        documentType: 'TAX_ID',
        docTypeLabel: 'ID local',
      },
    });
    const docs = await inTenant(a, () => repo.existingDocs(['RX9191']));
    expect(docs).toEqual([
      expect.objectContaining({
        id: existing.id,
        documentType: 'TAX_ID',
        docTypeLabel: 'ID local',
      }),
    ]);
    expect(docs[0]).not.toHaveProperty('docType');
    const batch = await prepared(
      a,
      [person('RX9191', { docType: 'TAX_ID', occupation: 'Docente' })],
      'FILL_EMPTY',
    );
    await runAll(a, batch!.id);
    const row = await raw.patientImportRow.findFirstOrThrow({
      where: { batchId: batch!.id },
    });
    expect(row).toMatchObject({ outcome: 'FILLED', patientId: existing.id });
    expect(
      await raw.patient.findUniqueOrThrow({ where: { id: existing.id } }),
    ).toMatchObject({
      occupation: 'Docente',
      documentType: 'TAX_ID',
      docTypeLabel: 'ID local',
    });
  });

  it('un bloque no escribe nada si el lote ya no está RUNNING (atascado → deshecho) (revisión I4)', async () => {
    const batch = await prepared(a, [
      person('9101'),
      person('9102'),
      person('9103'),
    ]);
    const running = await inTenant(a, () => repo.findBatch(batch!.id));
    // Primer bloque: 1 creado. Luego el worker «pierde» el arriendo.
    expect(
      (await inTenant(a, () => repo.processChunk(running!, 1, 'EMAIL')))
        .created,
    ).toBe(1);
    expect(await inTenant(a, () => repo.reapStuck())).toBeGreaterThanOrEqual(1);
    expect(await inTenant(a, () => repo.undo(batch!.id, a.userId))).toEqual({
      undoneCreated: 1,
      undoneFilled: 0,
      undoneBalances: 0,
    });
    // El worker original sigue vivo y procesa otro bloque: aborta sin escribir.
    await expect(
      inTenant(a, () => repo.processChunk(running!, 2, 'EMAIL')),
    ).rejects.toBeInstanceOf(BatchNotRunningError);
    expect(
      await raw.patient.count({
        where: { importBatchId: batch!.id, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await raw.patientImportBatch.findUniqueOrThrow({
        where: { id: batch!.id },
      }),
    ).toMatchObject({ status: 'UNDONE', createdCount: 1, processedRows: 1 });
  });

  it('carrera: un bloque en vuelo espera al deshacer (mismo candado) y no crea pacientes vivos en un lote UNDONE (revisión I4)', async () => {
    const batch = await prepared(a, [person('9201'), person('9202')]);
    const running = await inTenant(a, () => repo.findBatch(batch!.id));
    let chunk: Promise<unknown> | undefined;
    // Hace de «deshacer»: toma el lote FOR UPDATE (como `undo`), deja que
    // el bloque arranque y lo pasa a UNDONE antes de confirmar.
    await raw.$transaction(
      async (t) => {
        await t.$queryRaw`
          SELECT "status" FROM "patient_import_batches"
           WHERE "id" = ${batch!.id}::uuid FOR UPDATE`;
        chunk = inTenant(a, () =>
          repo.processChunk(running!, 2, 'EMAIL'),
        ).catch((e: unknown) => e);
        await new Promise((r) => setTimeout(r, 500));
        await t.patientImportBatch.update({
          where: { id: batch!.id },
          data: {
            status: 'UNDONE',
            undoneAt: new Date(),
            undoneById: a.userId,
          },
        });
      },
      { timeout: 10_000 },
    );
    expect(await chunk).toBeInstanceOf(BatchNotRunningError);
    expect(
      await raw.patient.count({ where: { importBatchId: batch!.id } }),
    ).toBe(0);
    expect(
      await raw.patientImportBatch.findUniqueOrThrow({
        where: { id: batch!.id },
      }),
    ).toMatchObject({ status: 'UNDONE', createdCount: 0, processedRows: 0 });
  });

  it('el sondeo no carga los errores enteros: la lista sin `issues` y el detalle solo con los primeros (revisión, menor 2)', async () => {
    const issues = Array.from({ length: 450 }, (_, i) => ({
      row: i + 2,
      column: 'doc',
      kind: 'ERROR',
      message: 'm',
      value: String(i),
    }));
    const big = await raw.patientImportBatch.create({
      data: batchData(b, {
        status: 'COMPLETED',
        duplicateMode: 'SKIP',
        confirmedById: b.userId,
        confirmedAt: new Date(),
        finishedAt: new Date(),
        issues,
      }),
    });
    const { items } = await inTenant(b, () => repo.listBatches(20, 0));
    const listed = items.find((x) => x.id === big.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('issues');
    const found = await inTenant(b, () => repo.findBatch(big.id));
    expect(found).not.toHaveProperty('issues');
    const head = await inTenant(b, () => repo.batchIssues(big.id, 200));
    expect(head.total).toBe(450);
    expect(head.issues).toHaveLength(200);
    expect(head.issues[0]).toMatchObject({ row: 2 });
    expect(head.issues[199]).toMatchObject({ row: 201 });
    expect((await inTenant(b, () => repo.allIssues(big.id)))?.length).toBe(450);
    // Otra clínica no los ve.
    expect(await inTenant(a, () => repo.batchIssues(big.id, 200))).toEqual({
      issues: [],
      total: 0,
    });
  });
});
