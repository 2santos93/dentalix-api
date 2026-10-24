import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaPatientImportRepository,
  UndoBlockedError,
} from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import type { ImportPatientData } from '../src/modules/patient-imports/domain/import-fields';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import type { PreparedBalance } from '../src/modules/patient-imports/domain/opening-balance-sheet';

// DX-262, capa DB del saldo migrado: RLS FORCE de opening_balances y de los
// saldos preparados, FK compuestas por tenant (paciente, sede, lote), CHECK
// de importe > 0, uno por (lote, paciente, moneda), inmutable salvo la
// retirada, y el resumen de la cartera (patient_ledgers, DX-155) que lo
// recoge por sus triggers. Las escrituras van por la ruta de la app
// (runWithTenant, rol dentalix_app); `raw` (DIRECT_URL) siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = [
  'opening-int-a',
  'opening-int-b',
  'opening-flow-a',
  'opening-flow-b',
  'opening-flow-big',
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
    // Como superusuario: los triggers de recibos y caja dejan borrar.
    await raw.paymentReceipt.deleteMany({ where });
    await raw.paymentReceiptCounter.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
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
}, 180_000);

afterAll(async () => {
  await purge();
  await prisma.onModuleDestroy();
  await raw.$disconnect();
}, 180_000);

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
        openings: [[created.id, 'COP', 150000.5, '2026-03-15', true, 0]],
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
const payments = new PrismaPaymentRepository(prisma, tenantContext);

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

  function payOpening(
    openingBalanceId: string,
    patientId: string,
    amount: number,
    currency = 'COP',
  ) {
    return tenantContext.run(a.tenantId, a.locationId, () =>
      payments.create({
        treatmentPlanId: null,
        openingBalanceId,
        patientId,
        amount,
        currency,
        paidAt: new Date('2026-10-20T15:00:00.000Z'),
        method: 'TRANSFER',
        createdById: a.userId,
        receiptPlanBalance: null,
      }),
    );
  }

  async function importedOpening(doc: string, cents: number) {
    const batch = await validated([person(doc)]);
    await inA(() =>
      repo.saveBalances(batch.id, sheet([balance(2, doc, cents)])),
    );
    await confirmAndRun(batch.id);
    const ob = await raw.openingBalance.findFirstOrThrow({
      where: { importBatchId: batch.id },
    });
    return { batch, ob };
  }

  const ledgerOfPatient = (patientId: string) =>
    raw.patientLedger.findUniqueOrThrow({
      where: { tenantId_patientId: { tenantId: a.tenantId, patientId } },
    });

  it('abono contra el saldo migrado: recibo consecutivo, la cartera ve lo pendiente y no admite pasarse (revisión C1)', async () => {
    const { ob } = await importedOpening('1313', 90_000);
    const first = await payOpening(ob.id, ob.patientId, 400);
    expect(first).toMatchObject({
      treatmentPlanId: null,
      openingBalanceId: ob.id,
      receiptNumber: expect.stringMatching(/^[A-Z0-9]+-\d{6}$/) as string,
    });
    const receipt = await raw.paymentReceipt.findFirstOrThrow({
      where: { paymentId: first.id },
    });
    expect(receipt.snapshot).toMatchObject({
      plan: null,
      openingBalance: { id: ob.id, concept: 'Saldo migrado' },
      planBalance: { currency: 'COP', billable: 900, paid: 400, balance: 500 },
    });
    let ledger = await ledgerOfPatient(ob.patientId);
    expect(ledger.owing).toBe(true);
    expect((ledger.ledger as { openings: unknown[][] }).openings[0][5]).toBe(
      400,
    );

    // Quedan 500; tras 300 quedan 200: dos cobros a la vez de 150, solo
    // uno entra (el saldo se bloquea en la transacción del abono).
    await payOpening(ob.id, ob.patientId, 300);
    const race = await Promise.allSettled([
      payOpening(ob.id, ob.patientId, 150),
      payOpening(ob.id, ob.patientId, 150),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = race.find((r) => r.status === 'rejected');
    expect(String(rejected?.reason)).toMatch(
      /supera lo pendiente del saldo migrado/,
    );
    await payOpening(ob.id, ob.patientId, 50);
    ledger = await ledgerOfPatient(ob.patientId);
    expect(ledger.owing).toBe(false);
    await expect(payOpening(ob.id, ob.patientId, 1)).rejects.toThrow(
      'Este saldo migrado ya está pagado: no admite más abonos.',
    );
    await expect(payOpening(ob.id, ob.patientId, 1, 'USD')).rejects.toThrow(
      'El abono al saldo migrado tiene que ir en su moneda (COP).',
    );
  });

  it('BD: un abono va a un plan O a un saldo migrado, y el saldo es del mismo paciente', async () => {
    const { ob } = await importedOpening('1414', 1_000);
    const other = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'O',
        lastName: 'Tro',
        docNumber: '1415',
      },
    });
    const base = {
      tenantId: a.tenantId,
      locationId: a.locationId,
      amount: new Prisma.Decimal(1),
      currency: 'COP',
      paidAt: new Date(),
    };
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, patientId: ob.patientId, treatmentPlanId: null },
        }),
      ),
    ).rejects.toThrow(/payments_target_check/);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.payment.create({
          data: { ...base, patientId: other.id, openingBalanceId: ob.id },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('deshacer se niega con abonos VIVOS al saldo migrado; uno anulado no cuenta (revisión C1, M4)', async () => {
    const { batch, ob } = await importedOpening('1515', 90_000);
    const paid = await payOpening(ob.id, ob.patientId, 100);
    const err = await inA(() => repo.undo(batch.id, a.userId)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UndoBlockedError);
    expect(err).toMatchObject({ balances: 1 });
    await expect(
      inA(() => repo.undoBalances(batch.id, a.userId)),
    ).rejects.toMatchObject({ balances: 1 });
    expect(
      (await raw.openingBalance.findUniqueOrThrow({ where: { id: ob.id } }))
        .voidedAt,
    ).toBeNull();

    await tenantContext.run(a.tenantId, a.locationId, () =>
      payments.softDelete(paid.id, {
        voidedById: a.userId,
        voidedByRole: 'ADMIN',
        voidedAt: new Date(),
        reason: 'Cobro duplicado',
        request: null,
      }),
    );
    await expect(inA(() => repo.undo(batch.id, a.userId))).resolves.toEqual({
      undoneCreated: 1,
      undoneFilled: 0,
      undoneBalances: 1,
    });
    // M8: la hora de la retirada es UTC (la de la BD), como el resto.
    const voided = await raw.openingBalance.findUniqueOrThrow({
      where: { id: ob.id },
    });
    expect(Math.abs(voided.voidedAt!.getTime() - Date.now())).toBeLessThan(
      60_000,
    );
  });

  it('deshacer SOLO los saldos aunque los pacientes del lote ya tengan actividad; con sus totales retirados', async () => {
    const { batch, ob } = await importedOpening('1616', 12_345);
    const start = new Date(Date.now() + 86_400_000);
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        patientId: ob.patientId,
        providerId: a.userId,
        locationId: a.locationId,
        start,
        end: new Date(start.getTime() + 1_800_000),
      },
    });
    await expect(
      inA(() => repo.undo(batch.id, a.userId)),
    ).rejects.toMatchObject({ patients: 1 });
    await expect(
      inA(() => repo.undoBalances(batch.id, a.userId)),
    ).resolves.toEqual({ undoneBalances: 1 });
    expect(await inA(() => repo.findBatch(batch.id))).toMatchObject({
      status: 'COMPLETED',
      balanceUndoneCount: 1,
      balanceUndoneTotals: [{ currency: 'COP', rows: 1, cents: 12_345 }],
    });
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: ob.patientId } }))
        .deletedAt,
    ).toBeNull();
    // Ya no queda nada que retirar.
    await expect(
      inA(() => repo.undoBalances(batch.id, a.userId)),
    ).resolves.toEqual({ undoneBalances: 0 });
  });

  it('saldos vivos de OTROS lotes por documento y moneda: importe, lote y corte (QA D1)', async () => {
    const { batch, ob } = await importedOpening('3434', 150_000);
    // Otro saldo (añadido a propósito) y después retirado: no cuenta.
    const retired = await validated([person('3434')]);
    await inA(() =>
      repo.saveBalances(retired.id, {
        ...sheet([balance(2, '3434', 1_000)]),
        addToExisting: true,
      }),
    );
    await confirmAndRun(retired.id);
    await inA(() => repo.undoBalances(retired.id, a.userId));
    const other = await validated([person('5656')]);
    const found = await inA(() =>
      repo.existingBalances(other.id, ['3434', '5656'], 'America/Bogota'),
    );
    expect([...found.entries()]).toEqual([
      [
        '3434\u0000COP',
        {
          count: 1,
          cents: 150_000,
          latest: {
            cents: 150_000,
            asOfDate: ob.asOfDate.toISOString().slice(0, 10),
            fileName: 'p.csv',
            importedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
          },
        },
      ],
    ]);
    // El propio lote no se cuenta a sí mismo.
    expect(
      (
        await inA(() =>
          repo.existingBalances(batch.id, ['3434'], 'America/Bogota'),
        )
      ).size,
    ).toBe(0);
  });

  it('el primer lote confirmado aún sin importar cuando se valida el segundo: el segundo NO duplica la deuda, salvo «Añadir» (QA D1)', async () => {
    // Al crear un lote se caducan los VALIDATED: la carrera real es un lote
    // confirmado (en cola) cuyo saldo aún no existe al validar el siguiente.
    const queue = async (rows: PreparedBalance[], addToExisting = false) => {
      const batch = await validated([person('7878')]);
      await inA(() =>
        repo.saveBalances(batch.id, { ...sheet(rows), addToExisting }),
      );
      return batch;
    };
    const first = await queue([balance(2, '7878', 5_000)]);
    await inA(async () => {
      const confirmed = await repo.confirm(first.id, {
        mode: 'SKIP',
        confirmedById: a.userId,
        validatedAfter: new Date(Date.now() - 3_600_000),
        enqueue: () => Promise.resolve(),
      });
      if (confirmed?.kind !== 'confirmed') throw new Error('no confirmado');
    });
    // El dry-run del segundo aún no ve ningún saldo vivo.
    const second = await queue([balance(2, '7878', 5_000)]);
    expect(
      (
        await inA(() =>
          repo.existingBalances(second.id, ['7878'], 'America/Bogota'),
        )
      ).size,
    ).toBe(0);
    // Corre el primero; después se confirma y corre el segundo.
    const started = await inA(() => repo.start(first.id));
    while (
      (await inA(() => repo.processChunk(started!, 2, 'EMAIL'))).processed
    );
    while (
      (await inA(() => repo.processBalanceChunk(started!, 2, '2026-10-23')))
        .processed
    );
    await inA(() => repo.finish(first.id, 'COMPLETED'));
    await confirmAndRun(second.id);
    // Con «Añadir» sí se crea otro.
    const third = await queue([balance(2, '7878', 700)], true);
    await confirmAndRun(third.id);

    expect(await inA(() => repo.findBatch(second.id))).toMatchObject({
      balanceProcessedRows: 1,
      balanceCreatedCount: 0,
      balanceSkippedCount: 0,
      balanceExistingCount: 1,
      balanceAddToExisting: false,
    });
    expect(await inA(() => repo.findBatch(third.id))).toMatchObject({
      balanceCreatedCount: 1,
      balanceExistingCount: 0,
      balanceAddToExisting: true,
    });
    const live = await raw.openingBalance.findMany({
      where: {
        tenantId: a.tenantId,
        voidedAt: null,
        patient: { docNumber: '7878' },
      },
      orderBy: { amount: 'desc' },
    });
    expect(live.map((o) => o.amount.toNumber())).toEqual([50, 7]);
  });

  it('un documento con varios pacientes vivos al importar se cuenta aparte (ambiguo), no como «sin paciente» (M7)', async () => {
    await raw.patient.createMany({
      data: [
        {
          tenantId: a.tenantId,
          firstName: 'A',
          lastName: '1',
          docNumber: '17.171',
        },
        {
          tenantId: a.tenantId,
          firstName: 'A',
          lastName: '2',
          docNumber: '17171',
        },
      ],
    });
    const batch = await validated([person('1818')]);
    await inA(() =>
      repo.saveBalances(
        batch.id,
        sheet([balance(2, '17171', 100), balance(3, '1818', 100)]),
      ),
    );
    await confirmAndRun(batch.id);
    expect(await inA(() => repo.findBatch(batch.id))).toMatchObject({
      balanceCreatedCount: 1,
      balanceSkippedCount: 0,
      balanceAmbiguousCount: 1,
      balanceProcessedRows: 2,
    });
  });

  it('retención (M3): a los 90 días de terminar se borran los saldos preparados del lote (documento e importe)', async () => {
    const { batch } = await importedOpening('1919', 100);
    expect(
      await raw.patientImportBalanceRow.count({ where: { batchId: batch.id } }),
    ).toBe(1);
    await raw.patientImportBatch.update({
      where: { id: batch.id },
      data: { finishedAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    await repo.purgeIssues(a.tenantId, new Date(Date.now() - 90 * 86_400_000));
    expect(
      await raw.patientImportBalanceRow.count({ where: { batchId: batch.id } }),
    ).toBe(0);
    // Lo importado sigue: solo se van los datos del fichero.
    expect(
      await raw.openingBalance.count({ where: { importBatchId: batch.id } }),
    ).toBe(1);
  });

  it('knownDocs por conjuntos (I1): 5.000 claves contra 20.000 pacientes en menos de 2 s', async () => {
    const big = await clinic('opening-flow-big');
    const docs = Array.from(
      { length: 20_000 },
      (_, i) => `55${String(i).padStart(7, '0')}`,
    );
    for (let i = 0; i < docs.length; i += 5_000) {
      await raw.patient.createMany({
        data: docs.slice(i, i + 5_000).map((d) => ({
          tenantId: big.tenantId,
          firstName: 'P',
          lastName: d,
          docNumber: d,
        })),
      });
    }
    const batch = await tenantContext.run(big.tenantId, () =>
      repo.createBatch({
        createdById: big.userId,
        locationId: big.locationId,
        fileName: 'p.csv',
        fileSha256: sha('big'),
        fileFormat: 'CSV',
        fileSizeBytes: 100,
        columnMapping: { columns: {} },
        totalRows: 1,
        validRows: 1,
        duplicateRows: 0,
        errorRows: 0,
        issues: [],
        rows: [{ rowNumber: 2, data: person('9999999') }],
      }),
    );
    const keys = [
      ...docs.filter((_, i) => i % 4 === 0).slice(0, 4_998),
      '9999999',
      '1',
    ];
    const t0 = Date.now();
    const found = await tenantContext.run(big.tenantId, () =>
      repo.knownDocs(batch.id, keys),
    );
    const ms = Date.now() - t0;
    expect(found.size).toBe(4_999);
    expect(found.get('9999999')).toBe('FOUND');
    expect(found.has('1')).toBe(false);
    expect(ms).toBeLessThan(2_000);
  });
});
