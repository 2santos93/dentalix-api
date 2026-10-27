import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-226 (DB-037): la hora que pone el servidor de BD en columnas `timestamp`
// sin zona es UTC, sea cual sea el TimeZone de la sesión. Con CURRENT_TIMESTAMP
// el valor se convertía a la zona de la sesión: con America/Bogota quedaba 5 h
// antes de lo que graba Prisma (UTC desde el cliente). Cada INSERT corre como
// dentalix_app con la clínica fijada (como la API) y `SET LOCAL TIME ZONE`
// fuera de UTC; la hora grabada tiene que coincidir (< 1 s) con
// `now() AT TIME ZONE 'UTC'` de la misma transacción. `raw` (DIRECT_URL,
// superusuario) solo siembra, lee la configuración de roles y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAIN = 'dx226-utc-int';
const EMAIL = 'dr@dx226-utc-int.test';
const ZONE = 'America/Bogota';

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  planId: string;
  userId: string;
}

let s: Seeded;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario: los triggers append-only dejan la purga administrativa.
  await raw.cashSessionAdjustment.deleteMany({ where });
  await raw.cashSessionReopening.deleteMany({ where });
  await raw.cashSessionClosingLine.deleteMany({ where });
  await raw.cashSessionClosing.deleteMany({ where });
  await raw.cashSessionFloat.deleteMany({ where });
  await raw.expensePayment.deleteMany({ where });
  await raw.expense.deleteMany({ where });
  await raw.expenseCategory.deleteMany({ where });
  await raw.clinicalEntryAddendum.deleteMany({ where });
  await raw.clinicalEntry.deleteMany({ where });
  await raw.patientImplant.deleteMany({ where });
  await raw.patientDocument.deleteMany({ where });
  await raw.collectionNote.deleteMany({ where });
  await raw.paymentPromise.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.paymentReceiptCounter.deleteMany({ where });
  // DX-051: imputaciones antes que su historial (borrarlas deja movimiento).
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.cashSession.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

/**
 * Corre `sql` como dentalix_app, con la clínica fijada y la sesión en Bogotá,
 * y devuelve la primera fila. `$1` es siempre el tenant.
 */
function inBogota<T>(
  sql: string,
  ...params: unknown[]
): Promise<T & { drift: number }> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${ZONE}'`);
    const [zone] = await tx.$queryRaw<{ tz: string }[]>`
      SELECT current_setting('TimeZone') AS tz`;
    expect(zone.tz).toBe(ZONE);
    const rows = await tx.$queryRawUnsafe<(T & { drift: number })[]>(
      sql,
      s.tenantId,
      ...params,
    );
    return rows[0];
  });
}

/**
 * Corre `fn` como dentalix_app (Prisma, como la API), con la clínica fijada y
 * la sesión en Bogotá.
 */
function txInBogota<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${ZONE}'`);
    return fn(tx);
  });
}

/** Segundos entre la columna y la hora UTC de la transacción. */
const drift = (column: string) =>
  `abs(extract(epoch FROM (${column} - (now() AT TIME ZONE 'UTC'))))::float8 AS drift`;

/** Segundos entre una columna de una fila y la hora UTC de la transacción. */
const utcDrift = async (
  tx: Prisma.TransactionClient,
  table: string,
  column: string,
  id: string,
) => {
  const [row] = await tx.$queryRawUnsafe<{ drift: number }[]>(
    `SELECT ${drift(`"${column}"`)} FROM "${table}" WHERE "id" = $1::uuid`,
    id,
  );
  return row.drift;
};

describe('hora del servidor en UTC con una sesión fuera de UTC (DX-226, int)', () => {
  beforeAll(async () => {
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede Centro',
        country: 'CO',
      }),
    });
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Zona' },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        currency: 'COP',
        status: 'ACCEPTED',
      },
    });
    const user = await raw.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Zona' },
    });
    s = {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      planId: plan.id,
      userId: user.id,
    };
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), appRole.$disconnect()]);
  });

  it('una sesión nueva de dentalix_app arranca en UTC (rol y base fijados)', async () => {
    const [app] = await appRole.$queryRaw<{ who: string; tz: string }[]>`
      SELECT current_user::text AS who, current_setting('TimeZone') AS tz`;
    expect(app).toEqual({ who: 'dentalix_app', tz: 'UTC' });
    const settings = await raw.$queryRaw<{ scope: string; tz: string }[]>`
      SELECT CASE WHEN s.setrole = 0 THEN 'database' ELSE r.rolname::text END AS scope,
             substr(c, length('timezone=') + 1) AS tz
        FROM pg_db_role_setting s
        LEFT JOIN pg_roles r ON r.oid = s.setrole
        CROSS JOIN LATERAL unnest(s.setconfig) AS c
       WHERE lower(c) LIKE 'timezone=%'
         AND ((s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
              OR (r.rolname = 'dentalix_app' AND s.setdatabase = 0))`;
    expect(settings).toEqual(
      expect.arrayContaining([
        { scope: 'database', tz: 'UTC' },
        { scope: 'dentalix_app', tz: 'UTC' },
      ]),
    );
  });

  it('ninguna función de public calcula la hora con la zona de la sesión (un trigger nuevo con CURRENT_TIMESTAMP falla aquí)', async () => {
    // Se quitan las formas en UTC (`timezone('UTC', now())` y
    // `now() AT TIME ZONE 'UTC'`) y se busca cualquier otra hora de la BD.
    // String.raw: las barras del regex llegan tal cual a Postgres.
    const offenders = await raw.$queryRawUnsafe<{ name: string }[]>(String.raw`
      SELECT p.proname::text AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND regexp_replace(
               regexp_replace(p.prosrc,
                 '(pg_catalog\.)?timezone\(''utc'',\s*(pg_catalog\.)?now\(\)\)', '', 'gi'),
               '(pg_catalog\.)?now\(\)\s+AT\s+TIME\s+ZONE\s+''utc''', '', 'gi')
             ~* '\mnow\(\)|current_timestamp|localtimestamp|\mlocaltime\M|current_date|current_time\M|statement_timestamp|clock_timestamp|transaction_timestamp'
       ORDER BY 1`);
    expect(offenders).toEqual([]);
  });

  it('clinical_entries y clinical_entry_addenda: createdAt en UTC', async () => {
    const entry = await inBogota<{ id: string }>(
      `INSERT INTO "clinical_entries" ("id", "tenantId", "patientId", "entryDate", "notes", "performedById")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, now() AT TIME ZONE 'UTC', 'Control', $3::uuid)
       RETURNING "id", ${drift('"createdAt"')}`,
      s.patientId,
      s.userId,
    );
    expect(entry.drift).toBeLessThan(1);
    const addendum = await inBogota<{ id: string }>(
      `INSERT INTO "clinical_entry_addenda" ("id", "tenantId", "patientId", "clinicalEntryId", "reason", "text", "authorId")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'Corrección de dato', 'Aclaración', $4::uuid)
       RETURNING "id", ${drift('"createdAt"')}`,
      s.patientId,
      entry.id,
      s.userId,
    );
    expect(addendum.drift).toBeLessThan(1);
  });

  it('patient_implants: createdAt en UTC', async () => {
    const implant = await inBogota<{ id: string }>(
      `INSERT INTO "patient_implants" ("id", "tenantId", "locationId", "patientId", "professionalId",
         "placedOn", "toothNumber", "kind", "manufacturer", "reference", "lot")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         (now() AT TIME ZONE 'UTC')::date, '36', 'IMPLANT', 'Fabricante', 'REF-1', 'LOT-1')
       RETURNING "id", ${drift('"createdAt"')}`,
      s.locationId,
      s.patientId,
      s.userId,
    );
    expect(implant.drift).toBeLessThan(1);
  });

  it('patient_documents: uploadedAt y createdAt en UTC', async () => {
    const doc = await inBogota<{ id: string; createdDrift: number }>(
      `INSERT INTO "patient_documents" ("id", "tenantId", "patientId", "locationId", "category",
         "originalName", "mimeType", "sizeBytes", "sha256", "storageKey", "uploadedById")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'XRAY',
         'rx.png', 'image/png', 10, repeat('a', 64), 'dx226-utc-int/rx.png', $4::uuid)
       RETURNING "id", ${drift('"uploadedAt"')},
         abs(extract(epoch FROM ("createdAt" - (now() AT TIME ZONE 'UTC'))))::float8 AS "createdDrift"`,
      s.patientId,
      s.locationId,
      s.userId,
    );
    expect(doc.drift).toBeLessThan(1);
    expect(doc.createdDrift).toBeLessThan(1);
  });

  it('collection_notes y payment_promises: createdAt en UTC', async () => {
    const note = await inBogota<{ id: string }>(
      `INSERT INTO "collection_notes" ("id", "tenantId", "patientId", "locationId", "channel", "outcome", "authorId")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'CALL', 'NO_ANSWER', $4::uuid)
       RETURNING "id", ${drift('"createdAt"')}`,
      s.patientId,
      s.locationId,
      s.userId,
    );
    expect(note.drift).toBeLessThan(1);
    const promise = await inBogota<{ id: string }>(
      `INSERT INTO "payment_promises" ("id", "tenantId", "patientId", "locationId", "amount", "currency", "dueDate", "createdById")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 1000, 'COP', (now() AT TIME ZONE 'UTC')::date + 10, $4::uuid)
       RETURNING "id", ${drift('"createdAt"')}`,
      s.patientId,
      s.locationId,
      s.userId,
    );
    expect(promise.drift).toBeLessThan(1);
  });

  it('payments (createdAt lo pone la BD aunque el INSERT traiga otro), payment_receipts (issuedAt) y patient_ledgers (updatedAt) en UTC', async () => {
    const row = await appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${ZONE}'`);
      // createdAt de un reloj de la API adelantado una hora: no cuenta.
      const [payment] = await tx.$queryRaw<{ id: string; drift: number }[]>`
        INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId",
          "amount", "currency", "paidAt", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${s.tenantId}::uuid, ${s.locationId}::uuid, ${s.planId}::uuid,
          ${s.patientId}::uuid, 5000, 'COP', now() AT TIME ZONE 'UTC',
          (now() AT TIME ZONE 'UTC') + interval '1 hour', now() AT TIME ZONE 'UTC')
        RETURNING "id", ${Prisma.raw(drift('"createdAt"'))}`;
      const [{ prefix }] = await tx.$queryRaw<{ prefix: string }[]>`
        SELECT "receiptPrefix" AS prefix FROM "locations" WHERE "id" = ${s.locationId}::uuid`;
      const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
        INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
        VALUES (${s.tenantId}::uuid, ${prefix}, 1)
        ON CONFLICT ("tenantId", "seriesPrefix")
        DO UPDATE SET "lastNumber" = "payment_receipt_counters"."lastNumber" + 1
        RETURNING "lastNumber"`;
      const [receipt] = await tx.$queryRaw<{ drift: number }[]>`
        INSERT INTO "payment_receipts" ("id", "tenantId", "locationId", "paymentId", "seriesPrefix", "number", "snapshot")
        VALUES (gen_random_uuid(), ${s.tenantId}::uuid, ${s.locationId}::uuid, ${payment.id}::uuid,
          ${prefix}, ${lastNumber}, '{"version": 1}'::jsonb)
        RETURNING ${Prisma.raw(drift('"issuedAt"'))}`;
      const [ledger] = await tx.$queryRaw<{ drift: number }[]>`
        SELECT ${Prisma.raw(drift('"updatedAt"'))}
          FROM "patient_ledgers"
         WHERE "tenantId" = ${s.tenantId}::uuid AND "patientId" = ${s.patientId}::uuid`;
      return { payment, receipt, ledger };
    });
    expect(row.payment.drift).toBeLessThan(1);
    expect(row.receipt.drift).toBeLessThan(1);
    expect(row.ledger.drift).toBeLessThan(1);
  });

  it('caja por turno (DX-027): apertura, cierre, reapertura y ajuste con la hora del servidor en UTC', async () => {
    // Apertura con su fondo (el trigger del fondo compara con la hora de la
    // apertura: si la fuente de hora no fuera la misma, fallaría).
    const session = await txInBogota(async (tx) => {
      const created = await tx.cashSession.create({
        data: {
          tenantId: s.tenantId,
          locationId: s.locationId,
          openedById: s.userId,
        },
      });
      await tx.cashSessionFloat.create({
        data: {
          tenantId: s.tenantId,
          sessionId: created.id,
          currency: 'COP',
          amount: 50_000,
        },
      });
      expect(
        await utcDrift(tx, 'cash_sessions', 'openedAt', created.id),
      ).toBeLessThan(1);
      return created;
    });
    // Cierre con su arqueo y el cambio de estado.
    const closing = await txInBogota(async (tx) => {
      const created = await tx.cashSessionClosing.create({
        data: {
          tenantId: s.tenantId,
          sessionId: session.id,
          sequence: 1,
          closedById: s.userId,
          blind: false,
          hasDifference: false,
          suggestedLockDate: new Date('2026-10-17T00:00:00.000Z'),
        },
      });
      await tx.cashSessionClosingLine.create({
        data: {
          tenantId: s.tenantId,
          closingId: created.id,
          currency: 'COP',
          method: 'CASH',
          opening: 50_000,
          expected: 50_000,
          counted: 50_000,
          difference: 0,
        },
      });
      await tx.cashSession.update({
        where: { id: session.id },
        data: { status: 'CLOSED', closedById: s.userId },
      });
      expect(
        await utcDrift(tx, 'cash_session_closings', 'closedAt', created.id),
      ).toBeLessThan(1);
      expect(
        await utcDrift(tx, 'cash_sessions', 'closedAt', session.id),
      ).toBeLessThan(1);
      return created;
    });
    // Reapertura y un ajuste pendiente.
    await txInBogota(async (tx) => {
      const reopening = await tx.cashSessionReopening.create({
        data: {
          tenantId: s.tenantId,
          sessionId: session.id,
          sequence: 1,
          closingId: closing.id,
          reason: 'Faltó un abono',
          reopenedById: s.userId,
        },
      });
      await tx.cashSession.update({
        where: { id: session.id },
        data: {
          status: 'OPEN',
          closedAt: null,
          closedById: null,
          reopenCount: 1,
        },
      });
      expect(
        await utcDrift(
          tx,
          'cash_session_reopenings',
          'reopenedAt',
          reopening.id,
        ),
      ).toBeLessThan(1);
      const adjustment = await tx.cashSessionAdjustment.create({
        data: {
          tenantId: s.tenantId,
          locationId: s.locationId,
          kind: 'CORRECTION',
          originalSessionId: session.id,
          currency: 'COP',
          method: 'CASH',
          amount: 100,
          reason: 'Corrección de prueba',
          createdById: s.userId,
        },
      });
      expect(
        await utcDrift(
          tx,
          'cash_session_adjustments',
          'createdAt',
          adjustment.id,
        ),
      ).toBeLessThan(1);
    });
  });

  it('gastos, pagos de gasto y categorías: createdAt y voidedAt en UTC (DX-274)', async () => {
    await txInBogota(async (tx) => {
      const category = await tx.expenseCategory.create({
        data: { tenantId: s.tenantId, name: 'Hora UTC', createdById: s.userId },
      });
      expect(
        await utcDrift(tx, 'expense_categories', 'createdAt', category.id),
      ).toBeLessThan(1);
      const expense = await tx.expense.create({
        data: {
          tenantId: s.tenantId,
          locationId: s.locationId,
          category: 'Otros',
          amount: 10_000,
          currency: 'COP',
          invoiceDate: new Date('2026-10-17T00:00:00.000Z'),
          createdById: s.userId,
        },
      });
      expect(
        await utcDrift(tx, 'expenses', 'createdAt', expense.id),
      ).toBeLessThan(1);
      const payment = await tx.expensePayment.create({
        data: {
          tenantId: s.tenantId,
          expenseId: expense.id,
          locationId: s.locationId,
          amount: 10_000,
          currency: 'COP',
          method: 'TRANSFER',
          paidOn: new Date('2026-10-17T00:00:00.000Z'),
          createdById: s.userId,
        },
      });
      expect(
        await utcDrift(tx, 'expense_payments', 'createdAt', payment.id),
      ).toBeLessThan(1);
      // La anulación también toma la hora del servidor, no la que mande la API.
      await tx.expensePayment.update({
        where: { id: payment.id },
        data: {
          voidedAt: new Date('2001-01-01T00:00:00.000Z'),
          voidedById: s.userId,
          voidReason: 'Pago duplicado',
        },
      });
      expect(
        await utcDrift(tx, 'expense_payments', 'voidedAt', payment.id),
      ).toBeLessThan(1);
      await tx.expense.update({
        where: { id: expense.id },
        data: {
          voidedAt: new Date('2001-01-01T00:00:00.000Z'),
          voidedById: s.userId,
          voidReason: 'Factura duplicada',
        },
      });
      expect(
        await utcDrift(tx, 'expenses', 'voidedAt', expense.id),
      ).toBeLessThan(1);
    });
  });

  it('imputación de abonos: base, imputación, cola e historial con la hora del servidor en UTC (DX-051)', async () => {
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: s.tenantId,
        code: 'dx051-utc',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    await txInBogota(async (tx) => {
      // El alta del ítem encola el plan (requestedAt).
      const item = await tx.treatmentPlanItem.create({
        data: {
          tenantId: s.tenantId,
          planId: s.planId,
          toothNumber: '11',
          catalogItemId: catalog.id,
          price: 10_000,
          status: 'ACCEPTED',
        },
      });
      const [request] = await tx.$queryRaw<{ drift: number }[]>`
        SELECT ${Prisma.raw(drift('"requestedAt"'))}
          FROM "plan_allocation_rebalance_requests"
         WHERE "treatmentPlanId" = ${s.planId}::uuid
         ORDER BY "id" DESC LIMIT 1`;
      expect(request.drift).toBeLessThan(1);
      const payment = await tx.payment.create({
        data: {
          tenantId: s.tenantId,
          locationId: s.locationId,
          treatmentPlanId: s.planId,
          patientId: s.patientId,
          amount: 5_000,
          currency: 'COP',
          paidAt: new Date(),
        },
      });
      // Lo que mande la API en createdAt/updatedAt no cuenta.
      const old = new Date('2001-01-01T00:00:00.000Z');
      await tx.paymentPlanAmount.create({
        data: {
          paymentId: payment.id,
          tenantId: s.tenantId,
          treatmentPlanId: s.planId,
          amount: 5_000,
          currency: 'COP',
          rateDate: new Date('2026-10-17T00:00:00.000Z'),
          createdAt: old,
        },
      });
      const [base] = await tx.$queryRaw<{ drift: number }[]>`
        SELECT ${Prisma.raw(drift('"createdAt"'))}
          FROM "payment_plan_amounts" WHERE "paymentId" = ${payment.id}::uuid`;
      expect(base.drift).toBeLessThan(1);
      const allocation = await tx.paymentAllocation.create({
        data: {
          tenantId: s.tenantId,
          paymentId: payment.id,
          treatmentPlanId: s.planId,
          treatmentPlanItemId: item.id,
          amount: 5_000,
          source: 'AUTO',
          createdAt: old,
          updatedAt: old,
        },
      });
      expect(
        await utcDrift(tx, 'payment_allocations', 'createdAt', allocation.id),
      ).toBeLessThan(1);
      expect(
        await utcDrift(tx, 'payment_allocations', 'updatedAt', allocation.id),
      ).toBeLessThan(1);
      const [movement] = await tx.$queryRaw<{ drift: number }[]>`
        SELECT ${Prisma.raw(drift('"at"'))}
          FROM "payment_allocation_movements"
         WHERE "paymentId" = ${payment.id}::uuid`;
      expect(movement.drift).toBeLessThan(1);
    });
  });
});
