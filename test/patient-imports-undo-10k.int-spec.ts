import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientImportRepository } from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import type { ImportPatientData } from '../src/modules/patient-imports/domain/import-fields';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-294: deshacer un lote RECIÉN importado de 10.000 pacientes, por la ruta
// de la app (runWithTenant, rol dentalix_app, RLS de verdad), con las
// estadísticas de `patients` de ANTES de la importación (VACUUM ANALYZE antes
// de importar: lo normal, el autoanalyze llega hasta un minuto después).
//
// Con el plan genérico de `patient_ledgers_refresh` (el trigger de cartera de
// cada UPDATE de pacientes) esto tardaba ~10 s (30 s con más pacientes en la
// clínica) y el proxy de la web cortaba la petición; con
// `plan_cache_mode = force_custom_plan` (migración 20261112090000) ~1 s.
// Mediciones y planes en REPORT-DX-294.
//
// `raw` (DIRECT_URL) solo siembra, lee, mide y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientImportRepository(prisma, tenantContext);

const SUBDOMAINS = ['imports-undo-10k-a', 'imports-undo-10k-b'];
const ROWS = 10_000;
/** Criterio de DX-294: por debajo del corte del proxy (30 s) con margen. */
const UNDO_BUDGET_MS = 3_000;

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

const people = (n: number, prefix: string): ImportPatientData[] =>
  Array.from({ length: n }, (_, i) => ({
    docType: 'NATIONAL_ID',
    docNumber: `${prefix}${String(i).padStart(6, '0')}`,
    firstName: `Paciente${i}`,
    lastName: 'Importado Masivo',
    email: `p${prefix}${i}@example.com`,
  }));

/** Un lote importado entero por la ruta de la app: dry-run, confirmar, bloques de 250 y terminar. */
async function imported(s: Seeded, rows: ImportPatientData[]): Promise<string> {
  const inTenant = <T>(fn: () => Promise<T>) =>
    tenantContext.run(s.tenantId, fn);
  const batch = await inTenant(() =>
    repo.createBatch({
      createdById: s.userId,
      locationId: s.locationId,
      fileName: 'pacientes.csv',
      fileSha256: createHash('sha256')
        .update(`${s.tenantId}${Math.random()}`)
        .digest('hex'),
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
  const confirmed = await inTenant(() =>
    repo.confirm(batch.id, {
      mode: 'SKIP',
      confirmedById: s.userId,
      validatedAfter: new Date(Date.now() - 3_600_000),
      enqueue: () => Promise.resolve(),
    }),
  );
  if (confirmed?.kind !== 'confirmed') throw new Error('no confirmado');
  const running = await inTenant(() => repo.start(batch.id));
  for (;;) {
    const r = await inTenant(() => repo.processChunk(running!, 250, 'EMAIL'));
    if (r.processed === 0) break;
  }
  await inTenant(() => repo.finish(batch.id, 'COMPLETED'));
  return batch.id;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

const alive = (where: Prisma.PatientWhereInput) =>
  raw.patient.count({ where: { ...where, deletedAt: null } });

describe('DX-294: deshacer 10.000 pacientes recién importados en < 3 s (int)', () => {
  jest.setTimeout(300_000);
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

  it('el refresco de cartera fija plan_cache_mode = force_custom_plan (un CREATE OR REPLACE sin él lo quitaría)', async () => {
    const [fn] = await raw.$queryRaw<{ config: string[] | null }[]>`
      SELECT p.proconfig AS config FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'patient_ledgers_refresh'`;
    expect(fn.config).toEqual(
      expect.arrayContaining([
        'plan_cache_mode=force_custom_plan',
        'search_path=pg_catalog, public, pg_temp',
      ]),
    );
  });

  it('con estadísticas de antes de importar: bloqueado por actividad sin tocar nada, y después deshecho solo lo del lote, todo en < 3 s', async () => {
    // Otra clínica con su propio lote (mismo documento) y un paciente de A que
    // no es del lote: nada de esto se toca.
    const otherBatch = await imported(b, people(50, '9'));
    const manual = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        documentType: 'NATIONAL_ID',
        docNumber: '8000001',
        firstName: 'Manual',
        lastName: 'Fuera del lote',
      },
    });

    // Estadísticas de `patients` de ANTES de la importación (el caso real).
    await raw.$executeRawUnsafe('VACUUM ANALYZE "patients"');
    const batchId = await imported(a, people(ROWS, '9'));
    expect(await alive({ importBatchId: batchId })).toBe(ROWS);

    // Uno de los 10.000 ya tiene una cita: se niega, sin retirar a nadie.
    const busy = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batchId },
      orderBy: { id: 'desc' },
    });
    const start = new Date(Date.now() + 86_400_000);
    const appointment = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        patientId: busy.id,
        providerId: a.userId,
        locationId: a.locationId,
        start,
        end: new Date(start.getTime() + 1_800_000),
      },
    });
    const blocked = await timed(() =>
      tenantContext
        .run(a.tenantId, () => repo.undo(batchId, a.userId))
        .then(
          () => null,
          (err: unknown) => err,
        ),
    );
    console.info(
      `[DX-294] deshacer ${ROWS} bloqueado por una cita: ${blocked.ms} ms`,
    );
    expect(blocked.value).toMatchObject({ patients: 1 });
    expect(blocked.ms).toBeLessThan(UNDO_BUDGET_MS);
    expect(await alive({ importBatchId: batchId })).toBe(ROWS);
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: batchId },
        })
      ).status,
    ).toBe('COMPLETED');

    // Sin la cita: se deshace entero.
    await raw.appointment.delete({ where: { id: appointment.id } });
    const undone = await timed(() =>
      tenantContext.run(a.tenantId, () => repo.undo(batchId, a.userId)),
    );
    console.info(`[DX-294] deshacer ${ROWS}: ${undone.ms} ms`);
    expect(undone.value).toEqual({
      undoneCreated: ROWS,
      undoneFilled: 0,
      undoneBalances: 0,
    });
    expect(undone.ms).toBeLessThan(UNDO_BUDGET_MS);

    expect(await alive({ importBatchId: batchId })).toBe(0);
    expect(await raw.patient.count({ where: { importBatchId: batchId } })).toBe(
      ROWS,
    );
    const after = await raw.patientImportBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    expect(after).toMatchObject({
      status: 'UNDONE',
      undoneById: a.userId,
      undoneCreated: ROWS,
      undoneFilled: 0,
    });
    // Aislamiento: la otra clínica y el paciente manual siguen vivos.
    expect(await alive({ importBatchId: otherBatch })).toBe(50);
    expect(await alive({ id: manual.id })).toBe(1);
    expect(
      (
        await raw.patientImportBatch.findUniqueOrThrow({
          where: { id: otherBatch },
        })
      ).status,
    ).toBe('COMPLETED');
  });
});
