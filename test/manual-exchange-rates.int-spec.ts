import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { resetDatabase } from './support/e2e-fixtures';

// DX-374, capa DB: `manual_exchange_rates` (tasas de cambio manuales de cada
// clínica) con RLS FORCE por tenant, única por (clínica, día, moneda), solo
// SELECT e INSERT para la app, CHECKs de tasa, moneda y día, y FK compuesta
// del autor a una membresía de la MISMA clínica. Las escrituras de la app van
// como dentalix_app (DATABASE_URL, sujeto a RLS) con `app.current_tenant`;
// `raw` (DIRECT_URL, superusuario) siembra, mira el catálogo y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

interface Seeded {
  tenantId: string;
  userId: string;
  membershipId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Admin ${subdomain}`,
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    membershipId: membership.id,
  };
}

function insertRate(
  tx: Prisma.TransactionClient,
  s: Seeded,
  values: { date?: string; currency?: string; rate?: string } = {},
  author: Pick<Seeded, 'userId' | 'membershipId'> = s,
): Promise<number> {
  return tx.$executeRawUnsafe(
    `INSERT INTO "manual_exchange_rates"
       ("id", "tenantId", "date", "currency", "rate", "createdById", "createdByMembershipId")
     VALUES (gen_random_uuid(), $1::uuid, $2::date, $3, $4::numeric, $5::uuid, $6::uuid)`,
    s.tenantId,
    values.date ?? '2026-10-29',
    values.currency ?? 'VES',
    values.rate ?? '36.12345678',
    author.userId,
    author.membershipId,
  );
}

describe('manual_exchange_rates (DX-374, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(raw);
    a = await seedClinic('dx374-int-a');
    b = await seedClinic('dx374-int-b');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('RLS FORCE con la política NULLIF de siempre', async () => {
    const [table] = await raw.$queryRaw<
      { rls: boolean; force: boolean }[]
    >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'manual_exchange_rates'`;
    expect(table).toEqual({ rls: true, force: true });
    const [policy] = await raw.$queryRaw<{ qual: string; check: string }[]>`
      SELECT qual, with_check AS check FROM pg_policies
       WHERE tablename = 'manual_exchange_rates' AND policyname = 'tenant_isolation'`;
    expect(policy.qual).toContain('NULLIF');
    expect(policy.check).toContain('NULLIF');
  });

  it('la clínica A no ve ni escribe tasas de la clínica B', async () => {
    await asApp(b.tenantId, (tx) => insertRate(tx, b));
    const seenByA = await asApp(a.tenantId, (tx) =>
      tx.manualExchangeRate.findMany({ select: { tenantId: true } }),
    );
    expect(seenByA).toEqual([]);
    const seenByB = await asApp(b.tenantId, (tx) =>
      tx.manualExchangeRate.findMany({ select: { tenantId: true } }),
    );
    expect(seenByB).toEqual([{ tenantId: b.tenantId }]);
    // Con el contexto de A, una fila de B no pasa el WITH CHECK.
    await expect(
      asApp(a.tenantId, (tx) => insertRate(tx, b, { currency: 'COP' })),
    ).rejects.toThrow(/row-level security/);
    // Sin clínica en el contexto (NULLIF de ''), nada.
    const anonymous = await appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', '', true)`;
      return tx.manualExchangeRate.count();
    });
    expect(anonymous).toBe(0);
  });

  it('única por clínica, día y moneda; la misma en otra clínica sí entra', async () => {
    await asApp(a.tenantId, (tx) =>
      insertRate(tx, a, { date: '2026-10-28', currency: 'COP' }),
    );
    await expect(
      asApp(a.tenantId, (tx) =>
        insertRate(tx, a, {
          date: '2026-10-28',
          currency: 'COP',
          rate: '4100',
        }),
      ),
    ).rejects.toThrow(/23505|Unique constraint/);
    await expect(
      asApp(b.tenantId, (tx) =>
        insertRate(tx, b, { date: '2026-10-28', currency: 'COP' }),
      ),
    ).resolves.toBe(1);
  });

  it('la app no puede cambiar ni borrar una tasa registrada', async () => {
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "manual_exchange_rates" SET "rate" = 1 WHERE "tenantId" = $1::uuid`,
          b.tenantId,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM "manual_exchange_rates" WHERE "tenantId" = $1::uuid`,
          b.tenantId,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it.each([
    ['tasa 0', { rate: '0' }, /manual_exchange_rates_rate_check/],
    ['tasa negativa', { rate: '-1' }, /manual_exchange_rates_rate_check/],
    ['USD', { currency: 'USD' }, /manual_exchange_rates_currency_check/],
    [
      'moneda fuera de la lista',
      { currency: 'ZZZ' },
      /manual_exchange_rates_currency_fkey/,
    ],
    [
      'día fuera de rango',
      { date: '1999-12-31' },
      /manual_exchange_rates_date_check/,
    ],
  ])('rechaza %s', async (_label, values, pattern) => {
    await expect(
      asApp(a.tenantId, (tx) =>
        insertRate(tx, a, { date: '2026-10-01', ...values }),
      ),
    ).rejects.toThrow(pattern);
  });

  it('guarda hasta 8 decimales sin redondear', async () => {
    await asApp(a.tenantId, (tx) =>
      insertRate(tx, a, {
        date: '2026-10-02',
        currency: 'EUR',
        rate: '0.00000001',
      }),
    );
    const row = await raw.manualExchangeRate.findFirstOrThrow({
      where: { tenantId: a.tenantId, currency: 'EUR' },
    });
    expect(row.rate.toFixed(8)).toBe('0.00000001');
  });

  it('el autor tiene que ser miembro de la MISMA clínica (FK compuesta)', async () => {
    await expect(
      asApp(a.tenantId, (tx) =>
        insertRate(tx, a, { date: '2026-10-03', currency: 'COP' }, b),
      ),
    ).rejects.toThrow(/manual_exchange_rates_created_by_fkey/);
  });

  it('"createdAt" lo pone la BD en UTC', async () => {
    const [row] = await asApp(a.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Caracas'`);
      await insertRate(tx, a, { date: '2026-10-04', currency: 'COP' });
      return tx.$queryRaw<{ drift: number }[]>`
        SELECT abs(extract(epoch FROM ("createdAt" - (now() AT TIME ZONE 'UTC'))))::float AS drift
          FROM "manual_exchange_rates"
         WHERE "tenantId" = ${a.tenantId}::uuid AND "date" = DATE '2026-10-04'`;
    });
    expect(row.drift).toBeLessThan(1);
  });

  it('una clínica existente queda en AUTOMATIC (default de la columna)', async () => {
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
      select: { exchangeRateSource: true },
    });
    expect(tenant.exchangeRateSource).toBe('AUTOMATIC');
  });

  it('EXCHANGE_RATE es un valor de AuditResourceType con su índice parcial', async () => {
    const [index] = await raw.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE indexname = 'audit_events_resource_exchange_rate_idx'`;
    expect(index.def).toContain(`'EXCHANGE_RATE'`);
  });
});
