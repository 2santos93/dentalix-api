import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

// DX-089, capa DB: sedes a las que se restringe un miembro de la clínica
// (membership_locations). Las escrituras van como el rol de la app
// (dentalix_app, sujeto a RLS, con `app.current_tenant` dentro de la
// transacción); `raw` (DIRECT_URL, owner) solo siembra, inspecciona el
// catálogo y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Conexión directa como el rol de la app.
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

interface Seeded {
  tenantId: string;
  userId: string;
  membershipId: string;
  locationId: string;
  otherLocationId: string;
}

// Prefijo propio: la limpieza borra también lo que dejara una ejecución
// anterior interrumpida.
const PREFIX = 'dx089-ml-';
const EMAIL_DOMAIN = '@dx089-ml.test';
const RUN = randomUUID().slice(0, 8);

async function seedClinic(name: string): Promise<Seeded> {
  const subdomain = `${PREFIX}${name}-${RUN}`;
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const user = await raw.user.create({
    data: {
      email: `${subdomain}${EMAIL_DOMAIN}`,
      passwordHash: 'x',
      fullName: `Recepción ${name}`,
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role: 'RECEPTION' },
  });
  const location = await raw.location.create({
    data: { tenantId, name: 'Norte' },
  });
  const other = await raw.location.create({ data: { tenantId, name: 'Sur' } });
  return {
    tenantId,
    userId: user.id,
    membershipId: membership.id,
    locationId: location.id,
    otherLocationId: other.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { startsWith: PREFIX } },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  const where = { tenantId: { in: tenantIds } };
  await raw.$executeRaw`DELETE FROM "membership_locations" WHERE "tenantId" = ANY(${tenantIds}::uuid[])`;
  await raw.clinicMembership.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

/** Código SQLSTATE de un error de Prisma ($executeRaw lo envuelve en P2010). */
function sqlState(e: unknown): string | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = e.meta as { code?: string } | undefined;
    return meta?.code ?? e.code;
  }
  return undefined;
}

async function expectSqlState(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(sqlState(caught)).toBe(code);
}

/** Ejecuta `fn` como dentalix_app con la clínica `tenantId` en contexto. */
function asTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

function insertRow(
  tx: Prisma.TransactionClient | PrismaClient,
  tenantId: string,
  membershipId: string,
  locationId: string,
) {
  return tx.$executeRaw`
    INSERT INTO "membership_locations" ("id", "tenantId", "membershipId", "locationId")
    VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${membershipId}::uuid, ${locationId}::uuid)`;
}

describe('membership_locations: sedes de un miembro (DX-089, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic('a');
    b = await seedClinic('b');
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('rechaza una sede de otra clínica aunque la membresía sea de la mía (FK compuesta → 23503)', async () => {
    await expectSqlState(
      asTenant(a.tenantId, (tx) =>
        insertRow(tx, a.tenantId, a.membershipId, b.locationId),
      ),
      FK_VIOLATION,
    );
  });

  it('rechaza una membresía de otra clínica aunque la sede sea de la mía (FK compuesta → 23503)', async () => {
    await expectSqlState(
      asTenant(a.tenantId, (tx) =>
        insertRow(tx, a.tenantId, b.membershipId, a.locationId),
      ),
      FK_VIOLATION,
    );
  });

  it('rechaza la misma sede dos veces para la misma membresía (23505)', async () => {
    await asTenant(a.tenantId, (tx) =>
      insertRow(tx, a.tenantId, a.membershipId, a.locationId),
    );
    await expectSqlState(
      asTenant(a.tenantId, (tx) =>
        insertRow(tx, a.tenantId, a.membershipId, a.locationId),
      ),
      UNIQUE_VIOLATION,
    );
    // Otra sede para la misma membresía sí entra.
    await asTenant(a.tenantId, (tx) =>
      insertRow(tx, a.tenantId, a.membershipId, a.otherLocationId),
    );
  });

  it('la tabla tiene RLS FORCE y policy tenant_isolation', async () => {
    const [table] = await raw.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'public.membership_locations'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await raw.$queryRaw<
      { policyname: string; qual: string | null; with_check: string | null }[]
    >`SELECT policyname, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'membership_locations'`;
    expect(policies).toHaveLength(1);
    expect(policies[0].policyname).toBe('tenant_isolation');
    expect(policies[0].qual).toContain('app.current_tenant');
    expect(policies[0].with_check).toContain('app.current_tenant');
  });

  it('como dentalix_app con el tenant A no ve las filas de B', async () => {
    await insertRow(raw, b.tenantId, b.membershipId, b.locationId);

    const seenByA = await asTenant(
      a.tenantId,
      (tx) =>
        tx.$queryRaw<
          { tenantId: string }[]
        >`SELECT "tenantId" FROM "membership_locations"`,
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.tenantId === a.tenantId)).toBe(true);

    // Y no puede escribir una fila con el tenantId de B (WITH CHECK).
    await expect(
      asTenant(a.tenantId, (tx) =>
        insertRow(tx, b.tenantId, b.membershipId, b.otherLocationId),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('borrar la membresía borra sus filas y borrar la sede está prohibido mientras tenga filas', async () => {
    // B tiene una fila (membresía de B → sede Norte de B).
    await expectSqlState(
      raw.$executeRaw`DELETE FROM "locations" WHERE "id" = ${b.locationId}::uuid`,
      FK_VIOLATION,
    );

    await raw.$executeRaw`DELETE FROM "clinic_memberships" WHERE "id" = ${b.membershipId}::uuid`;
    const [{ n }] = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "membership_locations"
      WHERE "membershipId" = ${b.membershipId}::uuid`;
    expect(n).toBe(0);

    // Sin filas que la usen, la sede ya se puede borrar.
    await raw.$executeRaw`DELETE FROM "locations" WHERE "id" = ${b.locationId}::uuid`;
  });
});
