import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  purgeTenants,
  tenantTablesInDeleteOrder,
  type SqlRunner,
} from './support/tenant-purge';

// DX-396 (TST-045): la purga de clínicas de los tests lee del catálogo qué
// tablas borrar y en qué orden. Una tabla nueva con FK a `tenants` (o a una
// tabla de clínica) entra sola en la purga; si no puede entrar (no tiene
// `tenantId`), la purga falla nombrándola en vez de dejar un «Test suite
// failed to run» por la FK al borrar el tenant.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/** Corre `fn` en una transacción que SIEMPRE se deshace (DDL incluido). */
async function inRolledBackTx(fn: (tx: SqlRunner) => Promise<void>) {
  const rollback = new Error('rollback');
  await expect(
    raw.$transaction(
      async (tx) => {
        await fn(tx);
        throw rollback;
      },
      { timeout: 60_000 },
    ),
  ).rejects.toBe(rollback);
}

interface Fk {
  child: string;
  parent: string;
}

async function foreignKeys(db: SqlRunner): Promise<Fk[]> {
  return db.$queryRawUnsafe<Fk[]>(`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    JOIN pg_class k ON k.oid = c.conrelid
    WHERE c.contype = 'f' AND NOT k.relispartition AND c.conrelid <> c.confrelid`);
}

const unquote = (name: string) => name.replace(/"/g, '');

async function insertTenant(db: SqlRunner): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO tenants (id, name, subdomain, "updatedAt")
     VALUES ($1::uuid, 'DX-396 sonda', $2, now())`,
    id,
    `dx396-${id.slice(0, 8)}`,
  );
  return id;
}

describe('Purga de clínicas desde el catálogo (int, DX-396)', () => {
  afterAll(() => raw.$disconnect());

  it('incluye toda tabla con FK a tenants (payment_methods entre ellas) y ninguna partición', async () => {
    const tables = await tenantTablesInDeleteOrder(raw);
    const direct = await raw.$queryRawUnsafe<{ table: string }[]>(`
      SELECT DISTINCT k.relname AS table
      FROM pg_constraint c JOIN pg_class k ON k.oid = c.conrelid
      WHERE c.contype = 'f' AND c.confrelid = 'public.tenants'::regclass
        AND NOT k.relispartition`);

    expect(tables).toContain('payment_methods');
    expect(tables).toEqual(expect.arrayContaining(direct.map((d) => d.table)));
    expect(tables).not.toContain('tenants');
    expect(tables.filter((t) => /^audit_events_/.test(t))).toEqual([]);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('ordena hijas antes que madres en toda FK entre tablas de clínica', async () => {
    const tables = await tenantTablesInDeleteOrder(raw);
    const pos = new Map(tables.map((t, i) => [t, i]));
    const misordered = (await foreignKeys(raw))
      .map((fk) => ({ child: unquote(fk.child), parent: unquote(fk.parent) }))
      .filter((fk) => pos.has(fk.child) && pos.has(fk.parent))
      .filter((fk) => pos.get(fk.child)! > pos.get(fk.parent)!);
    expect(misordered).toEqual([]);
  });

  it('una tabla nueva con FK RESTRICT a tenants (y su hija) entra en la purga y se borra', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_parent (
          id uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT
        )`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_child (
          id uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
          "parentId" uuid NOT NULL REFERENCES dx396_probe_parent(id) ON DELETE RESTRICT
        )`);

      const tables = await tenantTablesInDeleteOrder(tx);
      expect(tables).toContain('dx396_probe_parent');
      expect(tables.indexOf('dx396_probe_child')).toBeLessThan(
        tables.indexOf('dx396_probe_parent'),
      );

      const tenantId = await insertTenant(tx);
      const parentId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO dx396_probe_parent VALUES ($1::uuid, $2::uuid)`,
        parentId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO dx396_probe_child VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        randomUUID(),
        tenantId,
        parentId,
      );

      await purgeTenants(tx, [tenantId]);

      const left = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT ((SELECT count(*) FROM tenants WHERE id = $1::uuid)
               + (SELECT count(*) FROM dx396_probe_parent)
               + (SELECT count(*) FROM dx396_probe_child))::int AS n`,
        tenantId,
      );
      expect(left[0].n).toBe(0);
    });
  });

  it('borra antes la tabla cuyo trigger de DELETE escribe en otra (imputaciones → su historial)', async () => {
    const tables = await tenantTablesInDeleteOrder(raw);
    expect(tables.indexOf('payment_allocations')).toBeLessThan(
      tables.indexOf('payment_allocation_movements'),
    );
  });

  it('una tabla nueva cuyo trigger de DELETE inserta en otra de clínica queda vacía tras la purga', async () => {
    await inRolledBackTx(async (tx) => {
      // `a_log` va antes por nombre: sin la arista del trigger se borraría
      // primero y el DELETE de la madre volvería a llenarla.
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_a_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenantId" uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT
        )`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_z (
          id uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT
        )`);
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION dx396_probe_z_log() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO "dx396_probe_a_log" ("tenantId") VALUES (OLD."tenantId");
          RETURN OLD;
        END $$`);
      await tx.$executeRawUnsafe(`
        CREATE TRIGGER dx396_probe_z_log AFTER DELETE ON dx396_probe_z
        FOR EACH ROW EXECUTE FUNCTION dx396_probe_z_log()`);

      const tables = await tenantTablesInDeleteOrder(tx);
      expect(tables.indexOf('dx396_probe_z')).toBeLessThan(
        tables.indexOf('dx396_probe_a_log'),
      );

      const tenantId = await insertTenant(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO dx396_probe_z VALUES ($1::uuid, $2::uuid)`,
        randomUUID(),
        tenantId,
      );
      await purgeTenants(tx, [tenantId]);

      const left = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT ((SELECT count(*) FROM tenants WHERE id = $1::uuid)
               + (SELECT count(*) FROM dx396_probe_a_log))::int AS n`,
        tenantId,
      );
      expect(left[0].n).toBe(0);
    });
  });

  it('falla nombrando la tabla que referencia a una de clínica sin columna tenantId', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_orphan (
          id uuid PRIMARY KEY,
          "patientId" uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT
        )`);
      await expect(tenantTablesInDeleteOrder(tx)).rejects.toThrow(
        /dx396_probe_orphan.*patients/,
      );
    });
  });

  it('falla nombrando las tablas de un ciclo de FKs que no sabe ordenar', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_a (
          id uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL REFERENCES tenants(id),
          "bId" uuid
        )`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE dx396_probe_b (
          id uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL REFERENCES tenants(id),
          "aId" uuid REFERENCES dx396_probe_a(id)
        )`);
      await tx.$executeRawUnsafe(
        `ALTER TABLE dx396_probe_a ADD FOREIGN KEY ("bId") REFERENCES dx396_probe_b(id)`,
      );
      await expect(tenantTablesInDeleteOrder(tx)).rejects.toThrow(
        /ciclo.*dx396_probe_a.*dx396_probe_b/,
      );
    });
  });
});
