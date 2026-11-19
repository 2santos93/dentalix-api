import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaBankReconciliationRepository,
  activeMatchedPaymentsSql,
  activeMatchesInPeriodSql,
  movementsInPeriodSql,
  paymentsInRangeSql,
} from '../src/modules/bank-reconciliation/infrastructure/prisma-bank-reconciliation.repository';
import { releaseBankMatchOnVoid } from '../src/modules/bank-reconciliation/infrastructure/bank-match-on-void';
import {
  withNaturalKeys,
  type ParsedMovement,
} from '../src/modules/bank-reconciliation/domain/statement-parsing';
import type { StatementColumnMapping } from '../src/modules/bank-reconciliation/domain/statement-mapping';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-571 contra Postgres: la idempotencia de la importación (también con dos
// importaciones a la vez), RLS FORCE de las cinco tablas, lo append-only y la
// guarda del emparejado, la desconciliación al anular en la misma
// transacción, y el rendimiento con 5 000 movimientos por INVARIANTES del
// plan (sin Seq Scan en las tablas grandes, nº de consultas que no crece con
// las filas), nunca por milisegundos. `raw` (DIRECT_URL, dueño) solo siembra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaBankReconciliationRepository(prisma, tenantContext);

const VOLUME = 5_000;
/** Un mes fijo, lejos de «hoy»: el emparejado no mira el reloj. */
const MONTH_FROM = '2026-03-01';
const MONTH_TO = '2026-03-31';

const MAPPING: StatementColumnMapping = {
  date: 'Fecha',
  reference: 'Referencia',
  amount: 'Monto',
  dateOrder: 'DMY',
  decimalSeparator: ',',
};

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
  methodId: string;
  patientId: string;
  planId: string;
  accountId: string;
}

async function seedClinic(name: string): Promise<Clinic> {
  const subdomain = `dx571-${name}-${randomUUID().slice(0, 6)}`;
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
    select: { id: true },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Centro',
    }),
    select: { id: true },
  });
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Admin',
    },
    select: { id: true },
  });
  const method = await raw.clinicPaymentMethod.create({
    data: {
      tenantId: tenant.id,
      name: 'Pago móvil',
      kind: 'DIGITAL',
      requiresReference: true,
    },
    select: { id: true },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'María', lastName: 'Pérez' },
    select: { id: true },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'VES',
      status: 'ACCEPTED',
    },
    select: { id: true },
  });
  const ids = {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    methodId: method.id,
    patientId: patient.id,
    planId: plan.id,
  };
  const account = await tenantContext.run(tenant.id, () =>
    repo.createAccount(
      {
        name: 'Cuenta en bolívares',
        currency: 'VES',
        amountTolerance: 0,
        paymentMethodIds: [method.id],
      },
      user.id,
    ),
  );
  return { ...ids, accountId: account.id };
}

const as = <T>(c: Clinic, fn: () => Promise<T>) =>
  tenantContext.run(c.tenantId, fn);

function credits(n: number, prefix: string, cents = 100_00): ParsedMovement[] {
  return Array.from({ length: n }, (_, i) => ({
    rowNumber: i + 2,
    bookedOn: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`,
    reference: `${prefix}${i}`,
    referenceNormalized: `${prefix}${i}`.toUpperCase(),
    amountCents: cents,
    description: null,
  }));
}

const confirm = (c: Clinic, rows: ParsedMovement[], sha = 'a'.repeat(64)) =>
  as(c, () =>
    repo.confirmImport({
      accountId: c.accountId,
      fileSha256: sha,
      fileFormat: 'CSV',
      totalRows: rows.length,
      ignoredRows: 0,
      errorRows: 0,
      credits: withNaturalKeys(rows),
      mapping: MAPPING,
      userId: c.userId,
    }),
  );

/** Abonos por pago móvil con referencia, sembrados en bloque (dueño). */
async function seedPayments(
  c: Clinic,
  n: number,
  prefix: string,
  amount = 100,
) {
  await raw.$executeRaw`
    INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency",
                            "paidAt", "method", "paymentMethodId", "reference", "referenceNormalized", "updatedAt")
    SELECT gen_random_uuid(), ${c.tenantId}::uuid, ${c.locationId}::uuid, ${c.planId}::uuid, ${c.patientId}::uuid,
           ${amount}, 'VES',
           timestamp '2026-03-01 16:00' + ((g - 1) % 28) * interval '1 day',
           'TRANSFER', ${c.methodId}::uuid, ${prefix} || (g - 1), upper(${prefix} || (g - 1)), now()
      FROM generate_series(1, ${n}) AS g`;
}

const HISTORY = 30_000;

/** Un año (2025) de abonos y de movimientos ya importados de la cuenta. */
async function seedHistory(c: Clinic, n: number) {
  await raw.$executeRaw`
    INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency",
                            "paidAt", "method", "paymentMethodId", "reference", "referenceNormalized", "updatedAt")
    SELECT gen_random_uuid(), ${c.tenantId}::uuid, ${c.locationId}::uuid, ${c.planId}::uuid, ${c.patientId}::uuid,
           50, 'VES', timestamp '2025-01-01 16:00' + (g % 365) * interval '1 day',
           'TRANSFER', ${c.methodId}::uuid, 'H' || g, 'H' || g, now()
      FROM generate_series(1, ${n}) AS g`;
  const importId = randomUUID();
  await raw.$executeRaw`
    INSERT INTO "bank_statement_imports" ("id", "tenantId", "bankAccountId", "fileSha256", "fileFormat", "totalRows",
                                          "creditRows", "createdRows", "duplicateRows", "ignoredRows", "errorRows",
                                          "matchedRows", "periodFrom", "periodTo", "createdById")
    VALUES (${importId}::uuid, ${c.tenantId}::uuid, ${c.accountId}::uuid, ${'c'.repeat(64)}, 'CSV', ${n}, ${n}, ${n},
            0, 0, 0, 0, date '2025-01-01', date '2025-12-31', ${c.userId}::uuid)`;
  await raw.$executeRaw`
    INSERT INTO "bank_movements" ("id", "tenantId", "bankAccountId", "importId", "bookedOn", "reference",
                                  "referenceNormalized", "amount", "currency", "naturalKey")
    SELECT gen_random_uuid(), ${c.tenantId}::uuid, ${c.accountId}::uuid, ${importId}::uuid,
           date '2025-01-01' + (g % 365)::int, 'H' || g, 'H' || g, 50, 'VES',
           encode(sha256(convert_to('hist-' || g, 'UTF8')), 'hex')
      FROM generate_series(1, ${n}) AS g`;
  // Y conciliados: la historia de emparejados que tampoco se recorre (con
  // estadísticas al día, el cruce va por payments_tenant_method_reference_idx).
  await raw.$executeRaw`ANALYZE "payments"`;
  await raw.$executeRaw`ANALYZE "bank_movements"`;
  await raw.$executeRaw`
    INSERT INTO "bank_reconciliation_matches" ("id", "tenantId", "movementId", "paymentId", "bankAccountId",
                                               "bookedOn", "paidAt", "kind", "matchedById")
    SELECT gen_random_uuid(), m."tenantId", m."id", p."id", m."bankAccountId", m."bookedOn", p."paidAt",
           'AUTO', ${c.userId}::uuid
      FROM "bank_movements" m
      JOIN "payments" p ON p."tenantId" = m."tenantId" AND p."paymentMethodId" = ${c.methodId}::uuid
                       AND p."referenceNormalized" = m."referenceNormalized"
     WHERE m."tenantId" = ${c.tenantId}::uuid AND m."importId" = ${importId}::uuid`;
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}
const nodes = (n: PlanNode): PlanNode[] => [
  n,
  ...(n.Plans ?? []).flatMap(nodes),
];

async function explain(c: Clinic, sql: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await prisma.runWithTenant(c.tenantId, (tx) =>
    tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    ),
  );
  return nodes(rows[0]['QUERY PLAN'][0].Plan);
}

describe('DX-571 · conciliación bancaria en la BD (int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('a');
    b = await seedClinic('b');
  }, 180_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await prisma.$disconnect();
    await raw.$disconnect();
  }, 120_000);

  it('idempotencia: el mismo extracto dos veces no duplica; con dos importaciones a la vez, tampoco', async () => {
    const rows = credits(40, 'IDEM');
    const first = await confirm(a, rows);
    expect(first).toMatchObject({ created: 40, duplicates: 0 });
    const second = await confirm(a, rows);
    expect(second).toMatchObject({ created: 0, duplicates: 40 });
    // Un extracto que solapa (los 40 + 10 nuevos) solo añade los nuevos.
    const overlap = await confirm(a, [...rows, ...credits(10, 'IDEM-NUEVO')]);
    expect(overlap).toMatchObject({ created: 10, duplicates: 40 });
    // Dos a la vez con el mismo contenido nuevo: el bloqueo de la cuenta las
    // pone en fila; entre las dos crean 25, no 50.
    const parallel = credits(25, 'PAR');
    const [x, y] = await Promise.all([
      confirm(a, parallel),
      confirm(a, parallel),
    ]);
    expect(x.created + y.created).toBe(25);
    expect(x.duplicates + y.duplicates).toBe(25);
    expect(
      await raw.bankMovement.count({
        where: { tenantId: a.tenantId, reference: { startsWith: 'PAR' } },
      }),
    ).toBe(25);
  }, 60_000);

  it('la clave natural es única por cuenta en la BD (red bajo la API)', async () => {
    const one = await raw.bankMovement.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    await expect(
      raw.bankMovement.create({
        data: { ...one, id: randomUUID(), createdAt: undefined },
      }),
    ).rejects.toThrow(/Unique constraint|bank_movements_account_key_key/);
  });

  it('RLS FORCE: B no ve ni escribe filas de A en ninguna de las cinco tablas', async () => {
    const seen = await prisma.runWithTenant(b.tenantId, async (tx) => ({
      accounts: await tx.bankAccount.count({ where: { tenantId: a.tenantId } }),
      links: await tx.bankAccountPaymentMethod.count({
        where: { tenantId: a.tenantId },
      }),
      imports: await tx.bankStatementImport.count({
        where: { tenantId: a.tenantId },
      }),
      movements: await tx.bankMovement.count({
        where: { tenantId: a.tenantId },
      }),
      matches: await tx.bankReconciliationMatch.count({
        where: { tenantId: a.tenantId },
      }),
    }));
    expect(seen).toEqual({
      accounts: 0,
      links: 0,
      imports: 0,
      movements: 0,
      matches: 0,
    });
    // Con el GUC vacío, tampoco (NULLIF, DX-251).
    const empty = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', '', true)`;
      return tx.bankMovement.count();
    });
    expect(empty).toBe(0);
    // Escribir con el tenantId de A desde B: WITH CHECK lo rechaza.
    await expect(
      prisma.runWithTenant(b.tenantId, (tx) =>
        tx.bankAccount.create({
          data: {
            tenantId: a.tenantId,
            name: 'Intrusa',
            currency: 'VES',
            createdById: b.userId,
          },
        }),
      ),
    ).rejects.toThrow();
    // Y el repositorio de B no encuentra la cuenta de A.
    await expect(as(b, () => repo.findAccount(a.accountId))).rejects.toThrow();
  });

  it('append-only: el extracto importado no se cambia ni se borra; el emparejado solo se cierra', async () => {
    const movement = await raw.bankMovement.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "bank_movements" SET "amount" = 1 WHERE "id" = ${movement.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|no admite/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "bank_movements" WHERE "id" = ${movement.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|no admite/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) => tx.$executeRaw`DELETE FROM "bank_statement_imports"`,
      ),
    ).rejects.toThrow(/permission denied|no admite/);

    await seedPayments(a, 1, 'GUARD', 100);
    const payment = await raw.payment.findFirstOrThrow({
      where: { tenantId: a.tenantId, reference: 'GUARD0' },
    });
    const unmatched = await raw.bankMovement.findFirstOrThrow({
      where: {
        tenantId: a.tenantId,
        matches: { none: {} },
        reference: { startsWith: 'IDEM' },
      },
    });
    const match = await as(a, () =>
      repo.manualMatch(unmatched.id, payment.id, a.userId),
    );
    // Cambiar a qué abono apunta, o borrarlo: rechazado.
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "bank_reconciliation_matches" SET "kind" = 'AUTO' WHERE "id" = ${match.id}::uuid`,
      ),
    ).rejects.toThrow(/solo se cierra/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "bank_reconciliation_matches" WHERE "id" = ${match.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await as(a, () => repo.unmatch(match.id, a.userId));
    const ended = await raw.bankReconciliationMatch.findUniqueOrThrow({
      where: { id: match.id },
    });
    expect(ended).toMatchObject({
      endReason: 'UNMATCHED',
      endedById: a.userId,
    });
    // La hora la pone la BD; un cerrado no se reabre.
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "bank_reconciliation_matches" SET "endedAt" = NULL, "endedById" = NULL, "endReason" = NULL WHERE "id" = ${match.id}::uuid`,
      ),
    ).rejects.toThrow(/cerrado no cambia/);
  });

  it('anular el abono cierra su emparejado en la MISMA transacción (y si esa transacción falla, no)', async () => {
    await seedPayments(a, 1, 'VOID', 100);
    const payment = await raw.payment.findFirstOrThrow({
      where: { tenantId: a.tenantId, reference: 'VOID0' },
    });
    const movement = await raw.bankMovement.findFirstOrThrow({
      where: {
        tenantId: a.tenantId,
        matches: { none: {} },
        reference: { startsWith: 'IDEM' },
      },
    });
    await as(a, () => repo.manualMatch(movement.id, payment.id, a.userId));
    // Una anulación que falla después de cerrar el emparejado: todo vuelve atrás.
    await expect(
      prisma.runWithTenant(a.tenantId, async (tx) => {
        await releaseBankMatchOnVoid(tx, {
          tenantId: a.tenantId,
          paymentId: payment.id,
          voidedById: a.userId,
        });
        throw new Error('la anulación falló');
      }),
    ).rejects.toThrow('la anulación falló');
    expect(
      await raw.bankReconciliationMatch.count({
        where: { paymentId: payment.id, endedAt: null },
      }),
    ).toBe(1);
    const closed = await prisma.runWithTenant(a.tenantId, (tx) =>
      releaseBankMatchOnVoid(tx, {
        tenantId: a.tenantId,
        paymentId: payment.id,
        voidedById: a.userId,
      }),
    );
    expect(closed).toBe(1);
    expect(
      await raw.bankReconciliationMatch.findFirstOrThrow({
        where: { paymentId: payment.id },
      }),
    ).toMatchObject({ endReason: 'PAYMENT_VOIDED' });
    // Un abono anulado no se puede emparejar (guarda de la BD además de la API).
    await raw.payment.update({
      where: { id: payment.id },
      data: {
        deletedAt: new Date(),
        voidedAt: new Date(),
        voidedById: a.userId,
        voidReason: 'prueba',
      },
    });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.bankReconciliationMatch.create({
          data: {
            tenantId: a.tenantId,
            movementId: movement.id,
            paymentId: payment.id,
            bankAccountId: a.accountId,
            bookedOn: movement.bookedOn,
            paidAt: payment.paidAt,
            kind: 'MANUAL',
            matchedById: a.userId,
          },
        }),
      ),
    ).rejects.toThrow(/abono vivo/);
  });

  describe('rendimiento con 5 000 movimientos (invariantes del plan)', () => {
    let c: Clinic;

    beforeAll(async () => {
      c = await seedClinic('volumen');
      // 5 000 abonos del mes con referencia; el extracto trae los mismos 5 000.
      await seedPayments(c, VOLUME, 'PM');
      // Historia que el emparejado del mes no debe recorrer: otra clínica, y
      // un año de abonos y de extractos anteriores de esta misma cuenta.
      await seedPayments(b, VOLUME, 'OTRA');
      await seedHistory(c, HISTORY);
      await raw.$executeRaw`ANALYZE "payments"`;
      await raw.$executeRaw`ANALYZE "bank_movements"`;
      await raw.$executeRaw`ANALYZE "bank_reconciliation_matches"`;
    }, 300_000);

    it('importa 5 000 y empareja los 5 000 con un número de consultas que no crece con las filas', async () => {
      let queries = 0;
      // eslint-disable-next-line no-restricted-syntax -- un cliente observado solo para contar consultas
      const observed = new PrismaClient({
        log: [{ emit: 'event', level: 'query' }],
      });
      observed.$on('query', (event) => {
        if (/^\s*(SELECT|INSERT|UPDATE|WITH)/i.test(event.query)) queries += 1;
      });
      const adapter = {
        runWithTenant: <T>(
          fn: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: object,
        ) =>
          observed.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.current_tenant', ${c.tenantId}, true)`;
              return fn(tx);
            },
            { timeout: 120_000, maxWait: 10_000, ...(options ?? {}) },
          ),
      } as unknown as PrismaService;
      const observedRepo = new PrismaBankReconciliationRepository(
        adapter,
        tenantContext,
      );
      const run = (rows: ParsedMovement[]) =>
        as(c, () =>
          observedRepo.confirmImport({
            accountId: c.accountId,
            fileSha256: 'b'.repeat(64),
            fileFormat: 'CSV',
            totalRows: rows.length,
            ignoredRows: 0,
            errorRows: 0,
            credits: withNaturalKeys(rows),
            mapping: MAPPING,
            userId: c.userId,
          }),
        );
      try {
        queries = 0;
        const small = await run(credits(50, 'XX'));
        const few = queries;
        queries = 0;
        const big = await run(credits(VOLUME, 'PM'));
        const many = queries;
        expect(small).toMatchObject({ created: 50, matched: 0 });
        expect(big).toMatchObject({ created: VOLUME, matched: VOLUME });
        // Mismas consultas con 50 que con 5 000, salvo los lotes de
        // createMany que Prisma parte por el tope de parámetros (≤ 32 000).
        expect(many).toBeLessThanOrEqual(few + 4);
        queries = 0;
        const page = await as(c, () =>
          observedRepo.periodPage(
            c.accountId,
            MONTH_FROM,
            MONTH_TO,
            'CONCILIADO',
            1,
            25,
          ),
        );
        const pageQueries = queries;
        expect(page.counts.CONCILIADO).toBe(VOLUME);
        expect(page.items).toHaveLength(25);
        queries = 0;
        await as(c, () =>
          observedRepo.periodPage(
            c.accountId,
            MONTH_FROM,
            MONTH_TO,
            'CONCILIADO',
            1,
            100,
          ),
        );
        expect(queries).toBe(pageQueries);
      } finally {
        await observed.$disconnect();
      }
      await raw.$executeRaw`ANALYZE "bank_movements"`;
      await raw.$executeRaw`ANALYZE "bank_reconciliation_matches"`;
    }, 300_000);

    it('sin Seq Scan en bank_movements, payments ni bank_reconciliation_matches', async () => {
      const movements = await explain(
        c,
        movementsInPeriodSql(c.tenantId, c.accountId, MONTH_FROM, MONTH_TO),
      );
      const movementScans = movements.filter(
        (n) => n['Relation Name'] === 'bank_movements',
      );
      expect(movementScans.map((n) => n['Node Type'])).not.toContain(
        'Seq Scan',
      );
      // Index Scan, o Bitmap Index Scan (el nodo hijo lleva el índice).
      expect(
        movements.some(
          (n) => n['Index Name'] === 'bank_movements_account_booked_idx',
        ),
      ).toBe(true);

      const matches = await explain(
        c,
        activeMatchesInPeriodSql(c.tenantId, c.accountId, MONTH_FROM, MONTH_TO),
      );
      expect(
        matches
          .filter((n) => n['Relation Name'] === 'bank_reconciliation_matches')
          .map((n) => n['Node Type']),
      ).not.toContain('Seq Scan');
      expect(
        matches.some(
          (n) =>
            n['Index Name'] ===
            'bank_reconciliation_matches_account_booked_active_idx',
        ),
      ).toBe(true);
      const matchedPayments = await explain(
        c,
        activeMatchedPaymentsSql(
          c.tenantId,
          new Date('2026-02-24T00:00:00Z'),
          new Date('2026-04-07T00:00:00Z'),
        ),
      );
      expect(
        matchedPayments
          .filter((n) => n['Relation Name'] === 'bank_reconciliation_matches')
          .map((n) => n['Node Type']),
      ).not.toContain('Seq Scan');

      const payments = await explain(
        c,
        paymentsInRangeSql(
          c.tenantId,
          [c.methodId],
          'VES',
          new Date('2026-02-24T00:00:00Z'),
          new Date('2026-04-07T00:00:00Z'),
        ),
      );
      expect(
        payments
          .filter((n) => n['Relation Name'] === 'payments')
          .map((n) => n['Node Type']),
      ).not.toContain('Seq Scan');
    });

    it('las listas del período cuadran con 5 000 (todo conciliado; nada sin abono ni sin movimiento)', async () => {
      const summary = await as(c, () =>
        repo.periodSummary(c.accountId, MONTH_FROM, MONTH_TO),
      );
      expect(summary.counts).toEqual({
        CONCILIADO: VOLUME,
        IMPORTE_DISTINTO: 0,
        MOVIMIENTO_SIN_ABONO: 50,
        SIN_MOVIMIENTO: 0,
      });
    }, 120_000);
  });
});
