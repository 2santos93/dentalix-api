import type { PrismaClient } from '@prisma/client';

/** Lo que la purga necesita de un cliente: vale un PrismaClient o su `tx`. */
export type SqlRunner = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

interface TenantTableRow {
  table: string;
  columns: string[];
}

interface FkRow {
  child: string;
  parent: string;
  /** confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE, n/d = SET NULL/DEFAULT. */
  onDelete: string;
}

/**
 * Tablas de clínica de `public` (sin particiones: se borran por su madre) y
 * las columnas que las atan al tenant: las de sus FKs a `tenants` y, si no
 * tiene ninguna, `tenantId` (p. ej. `locations`, sin FK a `tenants`).
 */
function tenantTableRows(db: SqlRunner): Promise<TenantTableRow[]> {
  return db.$queryRawUnsafe<TenantTableRow[]>(`
    WITH t AS (
      SELECT k.oid, k.relname
      FROM pg_class k
      JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
      WHERE k.relkind IN ('r', 'p') AND NOT k.relispartition
        AND k.oid <> 'public.tenants'::regclass
    ), fk_cols AS (
      SELECT c.conrelid AS oid, a.attname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public.tenants'::regclass
    ), tenant_col AS (
      SELECT a.attrelid AS oid, a.attname
      FROM pg_attribute a
      WHERE a.attname = 'tenantId' AND a.attnum > 0 AND NOT a.attisdropped
    )
    SELECT t.relname AS table,
           coalesce(
             (SELECT array_agg(DISTINCT f.attname::text ORDER BY f.attname::text)
              FROM fk_cols f WHERE f.oid = t.oid),
             ARRAY[tc.attname::text]
           ) AS columns
    FROM t
    LEFT JOIN tenant_col tc ON tc.oid = t.oid
    WHERE EXISTS (SELECT 1 FROM fk_cols f WHERE f.oid = t.oid) OR tc.oid IS NOT NULL
    ORDER BY 1`);
}

function foreignKeyRows(db: SqlRunner): Promise<FkRow[]> {
  return db.$queryRawUnsafe<FkRow[]>(`
    SELECT ck.relname AS child, pk.relname AS parent, c.confdeltype::text AS "onDelete"
    FROM pg_constraint c
    JOIN pg_class ck ON ck.oid = c.conrelid
    JOIN pg_class pk ON pk.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = ck.relnamespace AND n.nspname = 'public'
    WHERE c.contype = 'f' AND NOT ck.relispartition AND c.conrelid <> c.confrelid
    ORDER BY 1, 2`);
}

interface TriggerWriteRow {
  /** Tabla con un trigger de DELETE… */
  table: string;
  /** …cuya función inserta filas en esta otra (p. ej. un historial). */
  writes: string;
}

/**
 * Triggers de DELETE que insertan en otra tabla: borrar `table` deja filas
 * nuevas en `writes` (p. ej. `payment_allocations` → su historial de
 * movimientos), así que `table` va antes que `writes`.
 */
function deleteTriggerWrites(db: SqlRunner): Promise<TriggerWriteRow[]> {
  return db.$queryRawUnsafe<TriggerWriteRow[]>(`
    SELECT DISTINCT k.relname AS table, lower(m[1]) AS writes
    FROM pg_trigger t
    JOIN pg_class k ON k.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
    JOIN pg_proc p ON p.oid = t.tgfoid
    CROSS JOIN LATERAL regexp_matches(
      p.prosrc, 'INSERT\\s+INTO\\s+(?:"?public"?\\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?', 'gi'
    ) AS m
    WHERE NOT t.tgisinternal AND NOT k.relispartition AND (t.tgtype & 8) <> 0
    ORDER BY 1, 2`);
}

async function tenantTablesWithColumns(
  db: SqlRunner,
): Promise<TenantTableRow[]> {
  const rows = await tenantTableRows(db);
  const byName = new Map(rows.map((r) => [r.table, r]));
  const fks = await foreignKeyRows(db);

  // Guarda: una tabla sin columna de tenant que impide borrar filas de clínica
  // (RESTRICT / NO ACTION) dejaría la purga a medias con un error de FK.
  const blockers = fks.filter(
    (fk) =>
      byName.has(fk.parent) &&
      !byName.has(fk.child) &&
      (fk.onDelete === 'a' || fk.onDelete === 'r'),
  );
  if (blockers.length > 0) {
    throw new Error(
      'purga de clínicas: ' +
        blockers
          .map((b) => `${b.child} referencia a ${b.parent} y no tiene tenantId`)
          .join('; ') +
        '. Dale una columna tenantId (con FK a tenants) para que la purga la borre.',
    );
  }

  // Orden topológico (Kahn): una tabla sale cuando ya no la referencia ninguna
  // tabla de clínica pendiente ni la escribe el trigger de borrado de otra
  // pendiente. Empates por nombre, para un orden estable.
  const referencedBy = new Map<string, Set<string>>(
    rows.map((r) => [r.table, new Set<string>()]),
  );
  for (const fk of fks) {
    if (byName.has(fk.child) && byName.has(fk.parent)) {
      referencedBy.get(fk.parent)!.add(fk.child);
    }
  }
  for (const w of await deleteTriggerWrites(db)) {
    if (w.table !== w.writes && byName.has(w.table) && byName.has(w.writes)) {
      referencedBy.get(w.writes)!.add(w.table);
    }
  }
  const ordered: TenantTableRow[] = [];
  const pending = new Set(referencedBy.keys());
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((t) => [...referencedBy.get(t)!].every((c) => !pending.has(c)))
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `purga de clínicas: ciclo de FKs (o de triggers de borrado) entre ${[...pending].sort().join(', ')}; ` +
          'no hay un orden de borrado seguro.',
      );
    }
    for (const t of ready) {
      pending.delete(t);
      ordered.push(byName.get(t)!);
    }
  }
  return ordered;
}

/**
 * Tablas de clínica en orden seguro para borrar (hijas primero), leídas de
 * `pg_constraint` (DX-396, TST-045): una tabla nueva entra sola.
 */
export async function tenantTablesInDeleteOrder(
  db: SqlRunner,
): Promise<string[]> {
  return (await tenantTablesWithColumns(db)).map((t) => t.table);
}

/**
 * Borra en duro (solo en bases de test) las clínicas `tenantIds` y todas sus
 * filas en las tablas de clínica. `db` debe ser el superusuario (DIRECT_URL):
 * salta la RLS y los triggers de inmutabilidad lo permiten.
 */
export async function purgeTenants(
  db: SqlRunner,
  tenantIds: string[],
): Promise<void> {
  if (tenantIds.length === 0) return;
  for (const { table, columns } of await tenantTablesWithColumns(db)) {
    const where = columns.map((c) => `"${c}" = ANY($1::uuid[])`).join(' OR ');
    await db.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE ${where}`,
      tenantIds,
    );
  }
  await db.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = ANY($1::uuid[])`,
    tenantIds,
  );
}

/** `purgeTenants` de las clínicas con esos subdominios (las que existan). */
export async function purgeTenantsBySubdomain(
  db: SqlRunner,
  subdomains: string[],
): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id::text AS id FROM tenants WHERE subdomain = ANY($1::text[])`,
    subdomains,
  );
  await purgeTenants(
    db,
    rows.map((r) => r.id),
  );
}
