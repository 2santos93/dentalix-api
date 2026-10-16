import { PrismaClient } from '@prisma/client';

/** Tabla de clínica y la columna que la ata al tenant. */
export interface TenantTable {
  table: string;
  column: string;
}

/**
 * Tablas de clínica de `public`, leídas del catálogo de Postgres (DX-068): las
 * que tienen una columna `tenantId`/`tenant_id` o una FK a `tenants(id)`.
 * Las comparten `rls-catalog.int-spec.ts` (invariante de RLS) y
 * `tenant-isolation-matrix.e2e-spec.ts` (fotografía de las filas de A).
 * `raw` debe ser la conexión DIRECT_URL (owner).
 */
export function clinicTables(raw: PrismaClient): Promise<TenantTable[]> {
  return raw.$queryRaw<TenantTable[]>`
    SELECT DISTINCT c.relname AS table, a.attname AS column
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND (
        a.attname IN ('tenantId', 'tenant_id')
        OR EXISTS (
          SELECT 1 FROM pg_constraint k
          WHERE k.contype = 'f'
            AND k.conrelid = c.oid
            AND k.confrelid = 'public.tenants'::regclass
            AND a.attnum = ANY (k.conkey)
        )
      )
    ORDER BY 1, 2`;
}
