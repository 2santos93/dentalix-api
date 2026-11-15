import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaPatientImportRepository,
  UndoBlockedError,
} from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import { PrismaReminderRepository } from '../src/modules/reminders/infrastructure/prisma-reminder.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-263, capa DB de la hoja de citas del importador: RLS FORCE y FK
// compuestas de patient_import_appointment_rows y de
// appointments.import_batch_id, CHECKs, anti-solape de la BD (EXCLUDE) entre
// citas del mismo lote y contra las existentes, deshacer (retira solo las
// citas del lote que siguen programadas; una que cambió de estado bloquea al
// paciente que creó el lote) y recordatorios retenidos hasta activarlos.
// Todo por la ruta de la app (runWithTenant, rol dentalix_app); `raw`
// (DIRECT_URL) solo siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientImportRepository(prisma, tenantContext);
const reminders = new PrismaReminderRepository(prisma, tenantContext);

const SUBDOMAINS = ['import-appts-int-a', 'import-appts-int-b'];
const HOUR = 3_600_000;

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
    await raw.patientImportAppointmentRow.deleteMany({ where });
    await raw.appointmentReminder.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
    await raw.job.deleteMany({ where });
    await raw.patientImportRow.deleteMany({ where });
    await raw.patient.updateMany({ where, data: { importBatchId: null } });
    await raw.patientImportBatch.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.locationReminderSettings.deleteMany({ where });
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
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
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
const inTenant = <T>(s: Seeded, fn: () => Promise<T>) =>
  tenantContext.run(s.tenantId, fn);

async function batchOf(
  s: Seeded,
  extra: Partial<Prisma.PatientImportBatchUncheckedCreateInput> = {},
) {
  return raw.patientImportBatch.create({
    data: {
      tenantId: s.tenantId,
      createdById: s.userId,
      locationId: s.locationId,
      fileName: 'p.csv',
      fileSha256: sha(String(Math.random())),
      fileFormat: 'CSV',
      fileSizeBytes: 10,
      columnMapping: {},
      totalRows: 1,
      validRows: 1,
      duplicateRows: 0,
      errorRows: 0,
      preparedRows: 1,
      ...(extra.status === 'COMPLETED'
        ? {
            duplicateMode: 'SKIP' as const,
            confirmedById: s.userId,
            confirmedAt: new Date(),
            finishedAt: new Date(),
          }
        : {}),
      ...extra,
    },
  });
}

async function patientOf(s: Seeded, doc: string, importBatchId?: string) {
  return raw.patient.create({
    data: {
      tenantId: s.tenantId,
      firstName: 'Ana',
      lastName: `Doc ${doc}`,
      documentType: 'NATIONAL_ID',
      docNumber: doc,
      importBatchId,
    },
  });
}

/** Una cita por la ruta de la app (RLS y EXCLUDE de verdad). */
function appointmentOf(
  s: Seeded,
  data: {
    patientId: string;
    start: Date;
    minutes?: number;
    importBatchId?: string;
    status?: 'SCHEDULED' | 'CONFIRMED';
    providerId?: string;
  },
) {
  return prisma.runWithTenant(s.tenantId, (tx) =>
    tx.appointment.create({
      data: {
        tenantId: s.tenantId,
        locationId: s.locationId,
        providerId: data.providerId ?? s.userId,
        patientId: data.patientId,
        start: data.start,
        end: new Date(data.start.getTime() + (data.minutes ?? 30) * 60_000),
        importBatchId: data.importBatchId,
        status: data.status,
      },
    }),
  );
}

describe('hoja de citas del importador: RLS, FK, EXCLUDE, deshacer y recordatorios (DX-263, int)', () => {
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

  it('RLS FORCE: una clínica no ve ni escribe las citas preparadas de otra', async () => {
    const batchB = await batchOf(b);
    const start = new Date(Date.now() + 48 * HOUR);
    await raw.patientImportAppointmentRow.create({
      data: {
        tenantId: b.tenantId,
        batchId: batchB.id,
        rowNumber: 2,
        docKey: 'V123',
        providerId: b.userId,
        locationId: b.locationId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    const seen = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.patientImportAppointmentRow.count(),
    );
    expect(seen).toBe(0);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImportAppointmentRow.create({
          data: {
            tenantId: b.tenantId,
            batchId: batchB.id,
            rowNumber: 3,
            docKey: 'V123',
            providerId: b.userId,
            locationId: b.locationId,
            start,
            end: new Date(start.getTime() + 30 * 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('FK compuestas: ni la cita ni la fila apuntan a un lote o una cita de otra clínica', async () => {
    const batchB = await batchOf(b);
    const patientA = await patientOf(a, 'FK1');
    await expect(
      appointmentOf(a, {
        patientId: patientA.id,
        start: new Date(Date.now() + 72 * HOUR),
        importBatchId: batchB.id,
      }),
    ).rejects.toThrow();
    const patientB = await patientOf(b, 'FK2');
    const appointmentB = await appointmentOf(b, {
      patientId: patientB.id,
      start: new Date(Date.now() + 72 * HOUR),
    });
    const batchA = await batchOf(a);
    const start = new Date(Date.now() + 96 * HOUR);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImportAppointmentRow.create({
          data: {
            tenantId: a.tenantId,
            batchId: batchA.id,
            rowNumber: 2,
            docKey: 'FK2',
            providerId: a.userId,
            locationId: a.locationId,
            start,
            end: new Date(start.getTime() + 30 * 60_000),
            outcome: 'CREATED',
            appointmentId: appointmentB.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('CHECKs: fin posterior al inicio, como mucho 480 min, y CREATED con su cita', async () => {
    const batch = await batchOf(a);
    const start = new Date(Date.now() + 120 * HOUR);
    const row = (
      extra: Partial<Prisma.PatientImportAppointmentRowUncheckedCreateInput>,
    ) =>
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImportAppointmentRow.create({
          data: {
            tenantId: a.tenantId,
            batchId: batch.id,
            rowNumber: 2,
            docKey: 'CHK1',
            providerId: a.userId,
            locationId: a.locationId,
            start,
            end: new Date(start.getTime() + 30 * 60_000),
            ...extra,
          },
        }),
      );
    await expect(row({ end: start })).rejects.toThrow(/values_check/);
    await expect(
      row({ end: new Date(start.getTime() + 481 * 60_000) }),
    ).rejects.toThrow(/values_check/);
    await expect(row({ outcome: 'CREATED' })).rejects.toThrow(/outcome_check/);
    await expect(row({ outcome: 'FILLED' })).rejects.toThrow(/outcome_check/);
    await expect(row({ docKey: 'v-1' })).rejects.toThrow(/values_check/);
  });

  it('anti-solape de la BD: dos citas del mismo lote, o una importada contra una existente, no pisan al profesional ni al paciente', async () => {
    const batch = await batchOf(a);
    const p1 = await patientOf(a, 'OV1', batch.id);
    const p2 = await patientOf(a, 'OV2', batch.id);
    const start = new Date(Date.now() + 150 * HOUR);
    await appointmentOf(a, {
      patientId: p1.id,
      start,
      importBatchId: batch.id,
    });
    // Mismo profesional, mismo lote, a la vez.
    await expect(
      appointmentOf(a, {
        patientId: p2.id,
        start: new Date(start.getTime() + 15 * 60_000),
        importBatchId: batch.id,
      }),
    ).rejects.toThrow(/appointments_no_overlap_per_provider/);
    // Mismo paciente con otro profesional (cita a mano existente).
    await expect(
      appointmentOf(a, {
        patientId: p1.id,
        start: new Date(start.getTime() + 10 * 60_000),
        providerId: '00000000-0000-4000-8000-000000000263',
        importBatchId: batch.id,
      }),
    ).rejects.toThrow();
    // Contigua [fin, fin+30): sí cabe.
    await appointmentOf(a, {
      patientId: p2.id,
      start: new Date(start.getTime() + 30 * 60_000),
      importBatchId: batch.id,
    });
  });

  it('deshacer retira en blando las citas del lote que siguen programadas y conserva las que cambiaron', async () => {
    const batch = await batchOf(a, {
      status: 'COMPLETED',
      appointmentFileName: 'citas.csv',
      appointmentFileSha256: sha('citas'),
      appointmentFileFormat: 'CSV',
      appointmentFileSizeBytes: 10,
    });
    const created = await patientOf(a, 'UN1', batch.id);
    const existing = await patientOf(a, 'UN2');
    const start = new Date(Date.now() + 200 * HOUR);
    const scheduled = await appointmentOf(a, {
      patientId: created.id,
      start,
      importBatchId: batch.id,
    });
    const confirmed = await appointmentOf(a, {
      patientId: existing.id,
      start: new Date(start.getTime() + HOUR),
      importBatchId: batch.id,
      status: 'CONFIRMED',
    });
    const result = await inTenant(a, () => repo.undo(batch.id, a.userId));
    expect(result).toMatchObject({ undoneCreated: 1, undoneAppointments: 1 });
    const after = await raw.appointment.findMany({
      where: { id: { in: [scheduled.id, confirmed.id] } },
    });
    const byId = new Map(after.map((x) => [x.id, x]));
    expect(byId.get(scheduled.id)?.deletedAt).not.toBeNull();
    expect(byId.get(confirmed.id)?.deletedAt).toBeNull();
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: batch.id },
        })
      ).appointmentUndoneCount,
    ).toBe(1);
  });

  it('deshacer se niega si una cita importada de un paciente del lote cambió de estado', async () => {
    const batch = await batchOf(a, { status: 'COMPLETED' });
    const created = await patientOf(a, 'BL1', batch.id);
    const appt = await appointmentOf(a, {
      patientId: created.id,
      start: new Date(Date.now() + 260 * HOUR),
      importBatchId: batch.id,
      status: 'CONFIRMED',
    });
    await expect(
      inTenant(a, () => repo.undo(batch.id, a.userId)),
    ).rejects.toBeInstanceOf(UndoBlockedError);
    expect(
      (await raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
        .deletedAt,
    ).toBeNull();
    // «Retirar citas importadas» tampoco toca la confirmada.
    await expect(
      inTenant(a, () => repo.undoAppointments(batch.id)),
    ).resolves.toEqual({ undoneAppointments: 0 });
  });

  it('la cita importada de OTRO lote sí es actividad: bloquea el deshacer', async () => {
    const batch = await batchOf(a, { status: 'COMPLETED' });
    const other = await batchOf(a, { status: 'COMPLETED' });
    const created = await patientOf(a, 'OT1', batch.id);
    await appointmentOf(a, {
      patientId: created.id,
      start: new Date(Date.now() + 300 * HOUR),
      importBatchId: other.id,
    });
    await expect(
      inTenant(a, () => repo.undo(batch.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
  });

  it('recordatorios: el barrido salta las citas importadas hasta que el ADMIN los activa en el lote', async () => {
    await raw.locationReminderSettings.upsert({
      where: {
        tenantId_locationId: { tenantId: a.tenantId, locationId: a.locationId },
      },
      create: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        enabled: true,
        leadHours: [24],
      },
      update: { enabled: true, leadHours: [24] },
    });
    const batch = await batchOf(a, { status: 'COMPLETED' });
    const now = new Date(Date.now() + 400 * HOUR);
    const start = new Date(now.getTime() + 24 * HOUR);
    const importedPatient = await patientOf(a, 'RM1');
    const manualPatient = await patientOf(a, 'RM2');
    await raw.patient.updateMany({
      where: { id: { in: [importedPatient.id, manualPatient.id] } },
      data: { contactChannel: 'EMAIL', email: 'paciente@example.com' },
    });
    const imported = await appointmentOf(a, {
      patientId: importedPatient.id,
      start,
      importBatchId: batch.id,
    });
    const manual = await appointmentOf(a, {
      patientId: manualPatient.id,
      start,
      providerId: '00000000-0000-4000-8000-000000000264',
    });
    const due = async () =>
      (await reminders.dueCandidates(a.tenantId, now)).map(
        (c) => c.appointmentId,
      );
    expect(await due()).toEqual([manual.id]);
    await inTenant(a, () =>
      repo.enableAppointmentReminders(batch.id, a.userId),
    );
    expect((await due()).sort()).toEqual([imported.id, manual.id].sort());
  });
});
