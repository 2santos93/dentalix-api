/**
 * Comprobación tras el despliegue (DX-134), en el paso 4 del runbook. Sale con
 * 1 si encuentra en la base:
 *   - `tables`: tablas de `public` con RLS activada y sin FORCE. Si una
 *     migración `…_reforce_*` (o una con NO FORCE/FORCE en su transacción)
 *     falla a medias, p. ej. por `lock_timeout`, el owner de las migraciones
 *     deja de estar sujeto a la RLS de esa tabla;
 *   - `rls_disabled`: tablas de clínica de `public` (columna `tenantId` /
 *     `tenant_id` o FK a `tenants`) sin RLS, salvo las exentas de
 *     test/rls-catalog.int-spec.ts, y particiones sin RLS de una tabla con RLS
 *     (consultadas directamente no aplican la del padre);
 *   - `members`: miembros de los roles NOLOGIN del clúster
 *     (`dentalix_patient_search`, `dentalix_email_dispatcher`) que no son el
 *     owner de esta base, o el owner con SET o INHERIT. ADMIN OPTION equivale
 *     a poder darse SET, y con SET se leen esas tablas de TODAS las bases del
 *     clúster: un owner por clúster (README).
 *
 *   npm run db:check-force
 *
 * Usa DIRECT_URL (o DATABASE_URL): el catálogo lo puede leer cualquier rol.
 * Salida: 0 si todo está bien; 1 y las listas si no; 2 si no pudo
 * comprobarlo. Recuperación: README, «Despliegue: roles de la BD». Solo
 * imprime nombres de tablas y roles.
 */
import { PrismaClient } from '@prisma/client';

/** Tablas de clínica sin RLS a propósito (mismo motivo que rls-catalog). */
const RLS_EXEMPT = [
  'tenant_domains',
  // DX-085: cola de trabajos de plataforma (justificación en rls-catalog).
  'jobs',
];

const CLUSTER_ROLES = ['dentalix_patient_search', 'dentalix_email_dispatcher'];

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DIRECT_URL o DATABASE_URL.');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const unforced = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
       ORDER BY 1`;
    const disabled = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relrowsecurity
         AND NOT c.relname = ANY(${RLS_EXEMPT})
         AND (
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname IN ('tenantId', 'tenant_id'))
           OR EXISTS (SELECT 1 FROM pg_constraint k
                       WHERE k.contype = 'f' AND k.conrelid = c.oid
                         AND k.confrelid = to_regclass('public.tenants'))
           OR (c.relispartition AND EXISTS (
                 SELECT 1 FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                  WHERE i.inhrelid = c.oid AND p.relrowsecurity))
         )
       ORDER BY 1`;
    const members = await prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT g.rolname || ':' || u.rolname AS name
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles u ON u.oid = m.member
       WHERE g.rolname = ANY(${CLUSTER_ROLES})
         AND (m.member <> (SELECT datdba FROM pg_database
                            WHERE datname = current_database())
              OR m.set_option OR m.inherit_option)
       ORDER BY 1`;
    const result = {
      tables: unforced.map((r) => r.name),
      rls_disabled: disabled.map((r) => r.name),
      members: members.map((r) => r.name),
    };
    if (Object.values(result).some((list) => list.length > 0)) {
      console.error(
        JSON.stringify({ event: 'db.check_force_failed', ...result }),
      );
      return 1;
    }
    console.log(JSON.stringify({ event: 'db.check_force_ok' }));
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        event: 'db.check_force_error',
        error: err instanceof Error ? err.message : 'unknown',
      }),
    );
    process.exit(2);
  },
);
