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
 *     (`dentalix_patient_search`, `dentalix_email_dispatcher`,
 *     `dentalix_membership_lookup`) que no son el
 *     owner de esta base, o el owner con SET o INHERIT. ADMIN OPTION equivale
 *     a poder darse SET, y con SET se leen esas tablas de TODAS las bases del
 *     clúster: un owner por clúster (README).
 *   - `dispatcher_delete`: tablas de `public` en las que
 *     `dentalix_email_dispatcher` tiene DELETE sin una política RESTRICTIVA
 *     para él que lo acote a `"tenantId" IS NULL` (DX-144: el rol solo purga
 *     emails de plataforma; con su política permisiva `USING (true)`, sin la
 *     restrictiva podría borrar filas de cualquier clínica).
 *   - `timezone`: `dentalix_app` no arranca en UTC (DX-226). Las horas son
 *     `timestamp` sin zona: Prisma graba UTC y los triggers, la hora del
 *     servidor en UTC; con otra zona en la sesión, lo que la BD calcula con
 *     la hora local (y cualquier SQL a mano) se desfasa. Se mira la zona que
 *     fija el catálogo para el rol en esta base (`ALTER ROLE … IN DATABASE`,
 *     `ALTER ROLE`, `ALTER DATABASE`, por ese orden; sin ninguna también
 *     falla) y, si `DATABASE_URL` es de `dentalix_app`, el `SHOW TimeZone`
 *     de una sesión real suya.
 *
 *   npm run db:check-force
 *
 * Usa DIRECT_URL (o DATABASE_URL): el catálogo lo puede leer cualquier rol.
 * Salida: 0 si todo está bien; 1 y las listas si no; 2 si no pudo
 * comprobarlo. Recuperación: README, «Despliegue: roles de la BD». Solo
 * imprime nombres de tablas y roles.
 */
import { Prisma, PrismaClient } from '@prisma/client';

/** Tablas de clínica sin RLS a propósito (mismo motivo que rls-catalog). */
const RLS_EXEMPT = [
  'tenant_domains',
  // DX-085: cola de trabajos de plataforma (justificación en rls-catalog).
  'jobs',
];

const CLUSTER_ROLES = [
  'dentalix_patient_search',
  'dentalix_email_dispatcher',
  // DX-143: lee las membresías de todas las clínicas (solo SELECT).
  'dentalix_membership_lookup',
];
const DISPATCHER_ROLE = 'dentalix_email_dispatcher';
const APP_ROLE = 'dentalix_app';
const REQUIRED_TIMEZONE = 'UTC';
const READ_ONLY_REFERENCES = [
  'icd10_codes',
  'currencies',
  'countries',
  'cities',
];

const TIMEZONE_MESSAGE =
  'La zona horaria de dentalix_app no es UTC: la hora del servidor tiene que ser UTC. ' +
  "Como el owner: ALTER ROLE dentalix_app SET timezone = 'UTC' y " +
  "ALTER DATABASE <base> SET timezone = 'UTC' (README, «Despliegue: roles de la BD»).";

const timezoneProblem = (found: string): string =>
  `${APP_ROLE}: TimeZone = ${found} (tiene que ser ${REQUIRED_TIMEZONE})`;

/**
 * Zona con la que arranca una sesión de dentalix_app en esta base según el
 * catálogo: la de rol + base, la del rol o la de la base, la primera que haya.
 */
async function catalogTimezone(prisma: PrismaClient): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ found: string | null }[]>`
    WITH me AS (
      SELECT (SELECT oid FROM pg_roles WHERE rolname = ${APP_ROLE}) AS role,
             (SELECT oid FROM pg_database WHERE datname = current_database()) AS db
    )
    SELECT (
      SELECT substr(c, length('timezone=') + 1)
        FROM pg_db_role_setting s, me, unnest(s.setconfig) AS c
       WHERE lower(c) LIKE 'timezone=%'
         AND ((s.setrole = me.role AND s.setdatabase IN (me.db, 0))
              OR (s.setrole = 0 AND s.setdatabase = me.db))
       ORDER BY (s.setrole <> 0 AND s.setdatabase <> 0) DESC, (s.setrole <> 0) DESC
       LIMIT 1
    ) AS found`;
  return rows[0]?.found ?? null;
}

/** `SHOW TimeZone` de una sesión real de la app (si DATABASE_URL es suya). */
async function liveTimezone(url: string): Promise<string | null> {
  const app = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url } },
  });
  try {
    const [row] = await app.$queryRaw<{ who: string; tz: string }[]>`
      SELECT current_user::text AS who, current_setting('TimeZone') AS tz`;
    return row.who === APP_ROLE ? row.tz : null;
  } finally {
    await app.$disconnect();
  }
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DIRECT_URL o DATABASE_URL.');
  const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url } },
  });
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
    const dispatcherDelete = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND CASE WHEN to_regrole(${DISPATCHER_ROLE}) IS NULL THEN false
                  ELSE has_table_privilege(${DISPATCHER_ROLE}, c.oid, 'DELETE') END
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = c.relname
              AND p.permissive = 'RESTRICTIVE'
              AND p.cmd IN ('DELETE', 'ALL')
              AND p.roles = ARRAY[${DISPATCHER_ROLE}]::name[]
              AND p.qual = '("tenantId" IS NULL)')
       ORDER BY 1`;
    const referenceWrites = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname || ':' || p.privilege AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
       WHERE n.nspname = 'public' AND c.relname = ANY(${READ_ONLY_REFERENCES})
         AND CASE WHEN to_regrole(${APP_ROLE}) IS NULL THEN false
                  ELSE has_table_privilege(${APP_ROLE}, c.oid, p.privilege) END
       ORDER BY 1`;
    const timezone = new Set<string>();
    const configured = await catalogTimezone(prisma);
    if (configured === null) {
      timezone.add(timezoneProblem('sin fijar en el rol ni en la base'));
    } else if (configured.toUpperCase() !== REQUIRED_TIMEZONE) {
      timezone.add(timezoneProblem(configured));
    }
    const appUrl = process.env.DATABASE_URL;
    if (appUrl) {
      const live = await liveTimezone(appUrl);
      if (live !== null && live.toUpperCase() !== REQUIRED_TIMEZONE) {
        timezone.add(timezoneProblem(live));
      }
    }
    const result = {
      tables: unforced.map((r) => r.name),
      rls_disabled: disabled.map((r) => r.name),
      members: members.map((r) => r.name),
      dispatcher_delete: dispatcherDelete.map((r) => r.name),
      timezone: [...timezone],
      reference_writes: referenceWrites.map((r) => r.name),
    };
    if (Object.values(result).some((list) => list.length > 0)) {
      console.error(
        JSON.stringify({
          event: 'db.check_force_failed',
          ...result,
          ...(timezone.size > 0 ? { message: TIMEZONE_MESSAGE } : {}),
        }),
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
