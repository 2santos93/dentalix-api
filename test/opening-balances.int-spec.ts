import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaPatientImportRepository,
  UndoBlockedError,
} from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import type { ImportPatientData } from '../src/modules/patient-imports/domain/import-fields';
import type { PreparedBalance } from '../src/modules/patient-imports/domain/opening-balance-sheet';

// DX-262, capa DB del saldo migrado: RLS FORCE de opening_balances y de los
// saldos preparados, FK compuestas por tenant (paciente, sede, lote), CHECK
// de importe > 0, uno por (lote, paciente, moneda), inmutable salvo la
// retirada, y el resumen de la cartera (patient_ledgers, DX-155) que lo
// recoge por sus triggers. Las escrituras van por la ruta de la app
// (runWithTenant, rol dentalix_app); `raw` (DIRECT_URL) siembra, lee y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = [
  'opening-int-a',
  'opening-int-b',
  'opening-flow-a',
  'opening-flow-b',
];

interface Seeded {
  tenantId: string;
  locationId: string;
  userId: string;
  patientId: string;
  batchId: string;
}

async function purge(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.openingBalance.deleteMany({ where });
    await raw.patientImportBalanceRow.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
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

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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
  const batch = await raw.patientImportBatch.create({
    data: {
      tenantId: tenant.id,
      createdById: user.id,
      locationId: location.id,
      fileName: 'p.csv',
      fileSha256: sha(subdomain),
      fileFormat: 'CSV',
      fileSizeBytes: 10,
      columnMapping: {},
      totalRows: 1,
      validRows: 1,
      duplicateRows: 0,
      errorRows: 0,
      preparedRows: 1,
    },
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: subdomain,
      docType: 'CC',
      docNumber: `9${Math.floor(Math.random() * 1e8)}`,
      importBatchId: batch.id,
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    patientId: patient.id,
    batchId: batch.id,
  };
}

function opening(
  s: Seeded,
  extra: Partial<Prisma.OpeningBalanceUncheckedCreateInput> = {},
): Prisma.OpeningBalanceUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    locationId: s.locationId,
    patientId: s.patientId,
    importBatchId: s.batchId,
    currency: 'COP',
    amount: new Prisma.Decimal('150000.50'),
    asOfDate: new Date('2026-03-15T00:00:00.000Z'),
    concept: 'Saldo migrado',
    createdById: s.userId,
    ...extra,
  };
}

interface LedgerRow {
  locationId: string | null;
  owing: boolean;
  ledger: { openings?: [string, string, number, string, boolean][] };
}

async function ledgerOf(s: Seeded): Promise<LedgerRow | undefined> {
  const rows = await raw.$queryRaw<LedgerRow[]>`
    SELECT "locationId", "owing", "ledger" FROM "patient_ledgers"
     WHERE "tenantId" = ${s.tenantId}::uuid AND "patientId" = ${s.patientId}::uuid`;
  return rows[0];
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await purge();
});

afterAll(async () => {
  await purge();
  await prisma.onModuleDestroy();
  await raw.$disconnect();
});

describe('opening_balances: RLS, FK, CHECKs, inmutable y resumen de cartera (DX-262, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    a = await seed(SUBDOMAINS[0]);
    b = await seed(SUBDOMAINS[1]);
  });

  afterEach(async () => {
    await raw.openingBalance.deleteMany({
      where: { tenantId: { in: [a.tenantId, b.tenantId] } },
    });
  });

  it('RLS FORCE: una clínica no ve ni escribe saldos migrados ni saldos preparados de otra', async () => {
    await raw.openingBalance.create({ data: opening(b) });
    await raw.patientImportBalanceRow.create({
      data: {
        tenantId: b.tenantId,
        batchId: b.batchId,
        rowNumber: 2,
        docKey: '123',
        currency: 'COP',
        amount: new Prisma.Decimal(10),
      },
    });
    const seen = await prisma.runWithTenant(a.tenantId, async (tx) => ({
      balances: await tx.openingBalance.count(),
      rows: await tx.patientImportBalanceRow.count(),
    }));
    expect(seen).toEqual({ balances: 0, rows: 0 });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.openingBalance.create({ data: opening(b) }),
      ),
    ).rejects.toThrow(/row-level security/);
    const forced = await raw.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class
       WHERE relname IN ('opening_balances', 'patient_import_balance_rows')`;
    expect(forced).toHaveLength(2);
    expect(forced.every((r) => r.relforcerowsecurity)).toBe(true);
    await raw.patientImportBalanceRow.deleteMany({
      where: { tenantId: b.tenantId },
    });
  });

  it('FK compuestas: ni paciente, ni sede, ni lote de otra clínica', async () => {
    for (const foreign of [
      { patientId: b.patientId },
      { locationId: b.locationId },
      { importBatchId: b.batchId },
    ]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.openingBalance.create({ data: opening(a, foreign) }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    }
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.openingBalance.create({ data: opening(a, { currency: 'XYZ' }) }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('CHECKs: importe > 0, concepto ≤ 200; y uno por (lote, paciente, moneda)', async () => {
    for (const bad of [
      { amount: new Prisma.Decimal(0) },
      { amount: new Prisma.Decimal(-5) },
      { concept: 'x'.repeat(201) },
      { concept: '' },
    ]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.openingBalance.create({ data: opening(a, bad) }),
        ),
      ).rejects.toThrow(/check constraint/i);
    }
    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.create({ data: opening(a) }),
    );
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.openingBalance.create({ data: opening(a) }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Otra moneda del mismo paciente en el mismo lote: sí.
    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.create({ data: opening(a, { currency: 'USD' }) }),
    );
  });

  it('inmutable: no cambia el importe ni se borra; solo se retira una vez', async () => {
    const created = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.create({ data: opening(a) }),
    );
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.openingBalance.update({
          where: { id: created.id },
          data: { amount: new Prisma.Decimal(1) },
        }),
      ),
    ).rejects.toThrow(/no se modifica/);
    await expect(
      // SQL a mano: la app ya lo impide (no-hard-delete); la BD también.
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "opening_balances" WHERE "id" = ${created.id}::uuid`,
      ),
    ).rejects.toThrow(/no se borra/);
    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.update({
        where: { id: created.id },
        data: { voidedAt: new Date(), voidedById: a.userId },
      }),
    );
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.openingBalance.update({
          where: { id: created.id },
          data: { voidedAt: new Date(), voidedById: a.userId },
        }),
      ),
    ).rejects.toThrow(/no se modifica/);
  });

  it('resumen de la cartera: el saldo migrado crea la fila del paciente sin planes, debe, da la sede y se va al retirarlo', async () => {
    const fresh = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Luis',
        lastName: 'Sin planes',
        docType: 'CC',
        docNumber: `8${Math.floor(Math.random() * 1e8)}`,
      },
    });
    const p = { ...a, patientId: fresh.id };
    expect(await ledgerOf(p)).toBeUndefined();
    const created = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.create({
        data: opening(p, { asOfDateApproximate: true }),
      }),
    );
    expect(await ledgerOf(p)).toEqual({
      locationId: a.locationId,
      owing: true,
      ledger: expect.objectContaining({
        plans: [],
        paymentPlans: [],
        openings: [[created.id, 'COP', 150000.5, '2026-03-15', true]],
      }) as LedgerRow['ledger'],
    });

    await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.openingBalance.update({
        where: { id: created.id },
        data: { voidedAt: new Date(), voidedById: a.userId },
      }),
    );
    expect(await ledgerOf(p)).toEqual({
      locationId: null,
      owing: false,
      ledger: expect.objectContaining({ openings: [] }) as LedgerRow['ledger'],
    });
  });
});

// ---------------------------------------------------------------------------
// Repositorio: hoja de saldos del lote, importación por bloques y deshacer.
// ---------------------------------------------------------------------------
const repo = new PrismaPatientImportRepository(prisma, tenantContext);

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
}

async function clinic(subdomain: string): Promise<Clinic> {
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

const person = (doc: string): ImportPatientData => ({
  docType: 'CC',
  docNumber: doc,
  firstName: 'Ana',
  lastName: `Doc ${doc}`,
});

const balance = (
  rowNumber: number,
  docKey: string,
  cents: number,
  currency = 'COP',
  asOfDate: string | null = null,
): PreparedBalance => ({
  rowNumber,
  docKey,
  currency,
  cents,
  asOfDate,
  concept: null,
  sourceRows: 1,
});

describe('hoja de saldos del lote: dry-run, importación por bloques y deshacer (DX-262, int)', () => {
  let a: Clinic;
  let b: Clinic;
  const inA = <T>(fn: () => Promise<T>) => tenantContext.run(a.tenantId, fn);

  beforeAll(async () => {
    a = await clinic(SUBDOMAINS[2]);
    b = await clinic(SUBDOMAINS[3]);
  });

  async function validated(rows: ImportPatientData[]) {
    return inA(() =>
      repo.createBatch({
        createdById: a.userId,
        locationId: a.locationId,
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
  }

  function sheet(prepared: PreparedBalance[]) {
    return {
      fileName: 'saldos.csv',
      fileSha256: sha(JSON.stringify(prepared) + Math.random()),
      fileFormat: 'CSV' as const,
      fileSizeBytes: 50,
      totalRows: prepared.length,
      errorRows: 0,
      mergedRows: 0,
      fileTotals: [],
      validTotals: [],
      issues: [],
      prepared,
    };
  }

  async function confirmAndRun(batchId: string, today = '2026-10-23') {
    await inA(async () => {
      const confirmed = await repo.confirm(batchId, {
        mode: 'SKIP',
        confirmedById: a.userId,
        validatedAfter: new Date(Date.now() - 3_600_000),
        enqueue: () => Promise.resolve(),
      });
      if (confirmed?.kind !== 'confirmed') throw new Error('no confirmado');
    });
    const batch = await inA(() => repo.start(batchId));
    for (;;) {
      const r = await inA(() => repo.processChunk(batch!, 2, 'EMAIL'));
      if (r.processed === 0) break;
    }
    for (;;) {
      const r = await inA(() => repo.processBalanceChunk(batch!, 2, today));
      if (r.processed === 0) break;
    }
    await inA(() => repo.finish(batchId, 'COMPLETED'));
  }

  it('documentos conocidos: de la clínica, del archivo de pacientes del lote, ninguno o ambiguo', async () => {
    await raw.patient.createMany({
      data: [
        {
          tenantId: a.tenantId,
          firstName: 'E',
          lastName: 'X',
          docNumber: '3.030.303',
        },
        {
          tenantId: a.tenantId,
          firstName: 'D',
          lastName: '1',
          docNumber: '4.444',
        },
        {
          tenantId: a.tenantId,
          firstName: 'D',
          lastName: '2',
          docNumber: '4444',
        },
      ],
    });
    // Un paciente de OTRA clínica con el mismo documento no cuenta.
    await raw.patient.create({
      data: {
        tenantId: b.tenantId,
        firstName: 'B',
        lastName: 'B',
        docNumber: '5555',
      },
    });
    const batch = await validated([person('1010')]);
    const docs = await inA(() =>
      repo.knownDocs(batch.id, ['3030303', '1010', '4444', '5555']),
    );
    expect(Object.fromEntries(docs)).toEqual({
      '3030303': 'FOUND',
      '1010': 'FOUND',
      '4444': 'AMBIGUOUS',
    });
  });

  it('guardar la hoja solo en un lote VALIDATED; volver a subirla la reemplaza; caducar la borra', async () => {
    const batch = await validated([person('2020')]);
    await inA(() =>
      repo.saveBalances(batch.id, sheet([balance(2, '2020', 100)])),
    );
    const replaced = await inA(() =>
      repo.saveBalances(batch.id, {
        ...sheet([balance(2, '2020', 500), balance(3, '2020', 700, 'USD')]),
        totalRows: 2,
      }),
    );
    expect(replaced).toMatchObject({
      balanceFileName: 'saldos.csv',
      balanceTotalRows: 2,
      balancePreparedRows: 2,
    });
    expect(
      await raw.patientImportBalanceRow.count({ where: { batchId: batch.id } }),
    ).toBe(2);
    // Otra clínica no la ve ni la toca.
    await expect(
      tenantContext.run(b.tenantId, () =>
        repo.saveBalances(batch.id, sheet([balance(2, '2020', 1)])),
      ),
    ).resolves.toBeNull();

    await inA(() => repo.expireBatch(batch.id));
    expect(
      await raw.patientImportBalanceRow.count({ where: { batchId: batch.id } }),
    ).toBe(0);
    await expect(
      inA(() => repo.saveBalances(batch.id, sheet([balance(2, '2020', 1)]))),
    ).rejects.toMatchObject({ status: 'EXPIRED' });
  });

  it('importar: un saldo por paciente y moneda, la suma cuadra por moneda, sin fecha = hoy aproximado; deshacer los retira', async () => {
    const existing = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Ya',
        lastName: 'Existe',
        docNumber: '6060',
      },
    });
    const batch = await validated([person('7070'), person('6060')]);
    await inA(() =>
      repo.saveBalances(
        batch.id,
        sheet([
          balance(2, '7070', 15_000_050, 'COP', '2026-03-15'),
          balance(3, '6060', 2_000_000, 'COP'),
          balance(4, '6060', 4_550, 'USD', '2025-12-31'),
        ]),
      ),
    );
    await confirmAndRun(batch.id);

    const created = await raw.patient.findFirstOrThrow({
      where: { importBatchId: batch.id },
    });
    const rows = await raw.openingBalance.findMany({
      where: { importBatchId: batch.id },
      orderBy: [{ currency: 'asc' }, { amount: 'asc' }],
    });
    expect(
      rows.map((r) => [
        r.patientId,
        r.currency,
        r.amount.toString(),
        r.asOfDate.toISOString().slice(0, 10),
        r.asOfDateApproximate,
        r.concept,
        r.locationId,
        r.createdById,
      ]),
    ).toEqual([
      [
        existing.id,
        'COP',
        '20000',
        '2026-10-23',
        true,
        'Saldo migrado',
        a.locationId,
        a.userId,
      ],
      [
        created.id,
        'COP',
        '150000.5',
        '2026-03-15',
        false,
        'Saldo migrado',
        a.locationId,
        a.userId,
      ],
      [
        existing.id,
        'USD',
        '45.5',
        '2025-12-31',
        false,
        'Saldo migrado',
        a.locationId,
        a.userId,
      ],
    ]);
    expect(await inA(() => repo.importedBalanceTotals(batch.id))).toEqual([
      { currency: 'COP', count: 2, cents: 17_000_050 },
      { currency: 'USD', count: 1, cents: 4_550 },
    ]);
    expect(await inA(() => repo.findBatch(batch.id))).toMatchObject({
      status: 'COMPLETED',
      balancePreparedRows: 3,
      balanceProcessedRows: 3,
      balanceCreatedCount: 3,
      balanceSkippedCount: 0,
    });
    // El resumen de la cartera ya los recoge (triggers por sentencia).
    const ledger = await raw.patientLedger.findUniqueOrThrow({
      where: {
        tenantId_patientId: { tenantId: a.tenantId, patientId: existing.id },
      },
    });
    expect(ledger.owing).toBe(true);

    const undone = await inA(() => repo.undo(batch.id, a.userId));
    expect(undone).toEqual({
      undoneCreated: 1,
      undoneFilled: 0,
      undoneBalances: 3,
    });
    expect(
      await raw.openingBalance.count({
        where: { importBatchId: batch.id, voidedAt: null },
      }),
    ).toBe(0);
    expect(await inA(() => repo.importedBalanceTotals(batch.id))).toEqual([]);
    expect(
      (
        await raw.patientLedger.findUniqueOrThrow({
          where: {
            tenantId_patientId: {
              tenantId: a.tenantId,
              patientId: existing.id,
            },
          },
        })
      ).owing,
    ).toBe(false);
  });

  it('un saldo cuyo paciente no llegó a existir (otro lo retiró) se salta y se cuenta', async () => {
    const gone = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Se',
        lastName: 'Va',
        docNumber: '8080',
      },
    });
    const batch = await validated([person('9090')]);
    await inA(() =>
      repo.saveBalances(
        batch.id,
        sheet([balance(2, '8080', 100), balance(3, '9090', 200)]),
      ),
    );
    await raw.patient.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });
    await confirmAndRun(batch.id);
    expect(await inA(() => repo.findBatch(batch.id))).toMatchObject({
      balanceCreatedCount: 1,
      balanceSkippedCount: 1,
      balanceProcessedRows: 2,
    });
  });

  it('deshacer se niega si un paciente creado por el lote tiene un saldo migrado de OTRO lote', async () => {
    const first = await validated([person('1212')]);
    await confirmAndRun(first.id);
    const second = await validated([person('1212')]);
    await inA(() =>
      repo.saveBalances(second.id, sheet([balance(2, '1212', 900)])),
    );
    await confirmAndRun(second.id);
    await expect(
      inA(() => repo.undo(first.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    // El segundo (solo saldos) sí se deshace.
    await expect(inA(() => repo.undo(second.id, a.userId))).resolves.toEqual({
      undoneCreated: 0,
      undoneFilled: 0,
      undoneBalances: 1,
    });
  });

  it('deshacer se niega con un abono imputado al saldo migrado (cualquier FK a opening_balances, del catálogo)', async () => {
    const batch = await validated([person('1313')]);
    await inA(() =>
      repo.saveBalances(batch.id, sheet([balance(2, '1313', 900)])),
    );
    await confirmAndRun(batch.id);
    const ob = await raw.openingBalance.findFirstOrThrow({
      where: { importBatchId: batch.id },
    });
    // Hoy ningún abono se imputa a un saldo migrado (DX-051). Una tabla que
    // lo haga (con FK a opening_balances) bloquea el deshacer sin tocar su
    // código: se simula con una tabla de prueba.
    await raw.$executeRawUnsafe(`
      CREATE TABLE "dx262_test_imputations" (
        "tenantId" UUID NOT NULL,
        "openingBalanceId" UUID NOT NULL,
        FOREIGN KEY ("tenantId", "openingBalanceId")
          REFERENCES "opening_balances"("tenantId", "id"))`);
    try {
      await raw.$executeRawUnsafe(
        `INSERT INTO "dx262_test_imputations" VALUES ($1::uuid, $2::uuid)`,
        a.tenantId,
        ob.id,
      );
      const fresh = new PrismaPatientImportRepository(prisma, tenantContext);
      const err = await tenantContext
        .run(a.tenantId, () => fresh.undo(batch.id, a.userId))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UndoBlockedError);
      expect(err).toMatchObject({ patients: 0, balances: 1 });
      expect(
        (await raw.openingBalance.findUniqueOrThrow({ where: { id: ob.id } }))
          .voidedAt,
      ).toBeNull();
    } finally {
      await raw.$executeRawUnsafe(`DROP TABLE "dx262_test_imputations"`);
    }
  });
});
