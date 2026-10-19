import { Prisma, PrismaClient } from '@prisma/client';

// DX-226 (DB-037): la hora que pone el servidor de BD en columnas `timestamp`
// sin zona es UTC, sea cual sea el TimeZone de la sesión. Con CURRENT_TIMESTAMP
// el valor se convertía a la zona de la sesión: con America/Bogota quedaba 5 h
// antes de lo que graba Prisma (UTC desde el cliente). Cada INSERT corre como
// dentalix_app con la clínica fijada (como la API) y `SET LOCAL TIME ZONE`
// fuera de UTC; la hora grabada tiene que coincidir (< 1 s) con
// `now() AT TIME ZONE 'UTC'` de la misma transacción. `raw` (DIRECT_URL,
// superusuario) solo siembra, lee la configuración de roles y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
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
  await raw.clinicalEntryAddendum.deleteMany({ where });
  await raw.clinicalEntry.deleteMany({ where });
  await raw.patientImplant.deleteMany({ where });
  await raw.collectionNote.deleteMany({ where });
  await raw.paymentPromise.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.paymentReceiptCounter.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
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

/** Segundos entre la columna y la hora UTC de la transacción. */
const drift = (column: string) =>
  `abs(extract(epoch FROM (${column} - (now() AT TIME ZONE 'UTC'))))::float8 AS drift`;

describe('hora del servidor en UTC con una sesión fuera de UTC (DX-226, int)', () => {
  beforeAll(async () => {
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    const location = await raw.location.create({
      data: { tenantId: tenant.id, name: 'Sede Centro', country: 'CO' },
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
});
