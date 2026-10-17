import { PrismaClient } from '@prisma/client';
import { clinicTables, TenantTable } from './support/tenant-tables';

/**
 * DX-068 (TST-002): invariante de RLS leída del catálogo de Postgres.
 *
 * `rls.isolation.int-spec.ts` prueba el comportamiento en una tabla; este
 * spec fija la CONFIGURACIÓN de todas. Una tabla de clínica (columna
 * `tenantId`/`tenant_id` o FK a `tenants(id)`, ver support/tenant-tables.ts)
 * debe tener RLS activada (relrowsecurity) y FORZADA (relforcerowsecurity; si
 * no, el owner que migra se la salta) y una política que ate esa columna al
 * tenant del contexto (`app.current_tenant`) al leer (USING) y al escribir
 * (WITH CHECK). Una tabla nueva sin RLS rompe la CI aquí.
 *
 * Lee el catálogo por DIRECT_URL (owner): pg_class y pg_policies no dependen
 * de la RLS, pero así el spec no depende de los GRANT del rol de la app.
 */

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/**
 * Tablas de clínica que NO llevan RLS, cada una con su motivo. Añadir una
 * entrada exige justificar por qué el aislamiento lo garantiza otra cosa.
 */
const RLS_EXEMPT: Record<string, string> = {
  // Ruteo host -> tenant: TenantHostMiddleware la consulta ANTES de conocer el
  // tenant (para resolverlo), igual que `tenants`. Las rutas de gestión
  // (/domains) filtran por el tenant del contexto en
  // PrismaTenantDomainRepository; lo prueba tenant-isolation-matrix
  // (POST /domains/:id/verify desde otra clínica → 404). Ver la migración
  // 20260723170000_add_tenant_domains.
  tenant_domains: 'ruteo host -> tenant, previo a conocer el tenant',
  // DX-085: cola de trabajos de PLATAFORMA. Un worker reclama trabajos de
  // todas las clínicas en una sentencia (FOR UPDATE SKIP LOCKED); "tenantId"
  // solo dice bajo qué clínica corre el handler, que fija app.current_tenant
  // (runWithTenant) antes de tocar datos de clínica. El payload lleva solo ids
  // (CHECK de 4 KB) y lastError solo tipo y código. Ver la migración
  // 20261017200000_dx085_jobs y jobs-queue.int-spec.ts.
  // RIESGO ACEPTADO (revisión DX-085, H3): dentalix_app lee y modifica filas
  // de jobs de cualquier clínica (una inyección SQL podría reprogramarlas).
  // La clínica de un trabajo la fija JobQueue (contexto y transacción deben
  // coincidir) y la fila no lleva datos del paciente; una RLS permisiva para
  // el worker sin tenant queda como seguimiento.
  jobs: 'cola de trabajos de plataforma; el handler corre bajo el tenant',
};

/**
 * Tablas de PLATAFORMA sin RLS a propósito y SIN columna de tenant (ni FK a
 * tenants), así que no son «de clínica» y la invariante de arriba no las ve.
 * Se fijan aquí para que añadirles un tenant (o RLS) obligue a revisar su
 * exención, igual que `jobs` (SEC-036).
 */
const PLATFORM_TABLES: Record<string, string> = {
  // DX-085: una fila por tarea programada (nombre, cron, ticks).
  job_schedules: 'tareas programadas de la cola de plataforma',
  // DX-220 (OPS-029): latido de cada proceso worker (id técnico, papel,
  // versión y fechas). La escribe el worker de todas las clínicas y la lee
  // GET /platform/jobs/stats (solo superadmin). Ver la migración
  // 20261018110000_dx220_job_workers_platform_audit.
  job_workers: 'latido de los workers de la cola de plataforma',
  // DX-220: acciones de un superadmin sobre la plataforma (reencolar un
  // trabajo), append-only y sin el payload del trabajo. Las acciones sobre
  // una clínica van a audit_events, con RLS.
  platform_audit_events: 'auditoría de acciones de plataforma del superadmin',
};

/**
 * Vistas y vistas materializadas de `public` permitidas sin
 * `security_invoker=true`. Hoy ninguna: una vista sin security_invoker lee
 * las tablas con los permisos de su owner (el de las migraciones, superusuario
 * que salta la RLS), y una materializada guarda una copia de las filas sin RLS
 * alguna. Añadir una entrada exige justificar que no expone filas de varias
 * clínicas.
 */
const VIEW_EXEMPT: Record<string, string> = {};

/**
 * Políticas permisivas extra permitidas, con la forma EXACTA que deben tener
 * (tabla, comando y roles). Añadir una entrada exige justificar que ningún rol
 * que pueda conectarse la recibe.
 */
const POLICY_EXEMPT: Record<
  string,
  { cmd: string; roles: string[]; reason: string }
> = {
  // DX-043: solo SELECT y solo para el rol NOLOGIN dueño de las funciones
  // SECURITY DEFINER de búsqueda, que filtran ellas mismas por
  // app.current_tenant (ver docs/adr/0001-busqueda-pacientes-rls.md y
  // patient-search.int-spec.ts). dentalix_app no la recibe.
  'patients.patient_search_definer': {
    cmd: 'SELECT',
    roles: ['dentalix_patient_search'],
    reason: 'búsqueda indexable de pacientes (DX-043)',
  },
  // DX-113: el rol NOLOGIN dueño de las funciones SECURITY DEFINER del
  // despachador de email (reclamar, cerrar, encolar de plataforma), que
  // trabaja para todas las clínicas sin que el owner salte la RLS. Ningún rol
  // que pueda conectarse la recibe (email-outbox.int-spec.ts).
  'email_outbox.email_outbox_dispatcher': {
    cmd: 'ALL',
    roles: ['dentalix_email_dispatcher'],
    reason: 'despachador de email de todas las clínicas (DX-088, DX-113)',
  },
  // DX-143 (SEC-033): solo SELECT y solo para el rol NOLOGIN dueño de
  // dx_user_has_other_active_memberships, que devuelve un booleano (¿tiene el
  // usuario membresías activas en otra clínica?) para no dejar reclamar una
  // cuenta con acceso a otra clínica. dentalix_app no la recibe
  // (account-claim-memberships.int-spec.ts).
  'clinic_memberships.membership_lookup_definer': {
    cmd: 'SELECT',
    roles: ['dentalix_membership_lookup'],
    reason: 'reclamo de cuenta acotado a cuentas sin otras clínicas (DX-143)',
  },
};

/**
 * Políticas RESTRICTIVAS esperadas, con su forma EXACTA. Una restrictiva solo
 * recorta (se suma con AND), pero también fija qué puede hacer un rol NOLOGIN:
 * cambiarla o quitarla debe revisarse aquí.
 */
const RESTRICTIVE_POLICIES: Record<
  string,
  { cmd: string; roles: string[]; using: string; reason: string }
> = {
  // DX-144 (SEC-037): el rol despachador recibe DELETE para purgar los emails
  // de PLATAFORMA; su permisiva `USING (true)` le dejaría borrar filas de
  // cualquier clínica, y esta lo acota (db:check-force también lo vigila).
  'email_outbox.email_outbox_dispatcher_delete_platform': {
    cmd: 'DELETE',
    roles: ['dentalix_email_dispatcher'],
    using: '("tenantId" IS NULL)',
    reason: 'purga de emails de plataforma (DX-144)',
  },
};

/** La forma exacta que generan las migraciones (ver p. ej. la de patients). */
function tenantPredicate(column: string): string {
  return `("${column}" = (current_setting('app.current_tenant'::text, true))::uuid)`;
}

interface TableRls {
  table: string;
  rls: boolean;
  forced: boolean;
}

interface Policy {
  table: string;
  policy: string;
  cmd: string;
  permissive: string;
  using: string | null;
  check: string | null;
  roles: string[];
}

interface Column {
  table: string;
  column: string;
}

interface View {
  view: string;
  kind: string;
  options: string[] | null;
}

describe('Catálogo de RLS (DX-068)', () => {
  let clinic: TenantTable[];
  let rls: TableRls[];
  let policies: Policy[];

  const clinicTableNames = (): string[] => [
    ...new Set(clinic.map((t) => t.table)),
  ];
  const checked = (): TenantTable[] =>
    clinic.filter((t) => !(t.table in RLS_EXEMPT));

  beforeAll(async () => {
    clinic = await clinicTables(raw);
    rls = await raw.$queryRaw<TableRls[]>`
      SELECT c.relname AS table,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
    policies = await raw.$queryRaw<Policy[]>`
      SELECT tablename AS table, policyname AS policy, cmd, permissive,
             qual AS using, with_check AS check, roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname`;
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it('encuentra las tablas de clínica (la consulta no está vacía)', () => {
    expect(clinicTableNames().length).toBeGreaterThanOrEqual(30);
    expect(clinicTableNames()).toEqual(
      expect.arrayContaining([
        'patients',
        'payments',
        'clinic_memberships',
        // DX-085: nueva tabla de clínica, con RLS forzada.
        'outbound_messages',
      ]),
    );
  });

  it('ninguna columna con «tenant» en el nombre queda fuera de las tablas de clínica', async () => {
    // Una columna de tenant con otro nombre (p. ej. `clinicTenant`) y sin FK
    // a tenants(id) escaparía a la detección y, con ella, a la invariante.
    const columns = await raw.$queryRaw<Column[]>`
      SELECT c.relname AS table, a.attname AS column
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND a.attname ILIKE '%tenant%'
      ORDER BY 1, 2`;
    const outside = columns
      .filter(
        (col) =>
          !clinic.some((t) => t.table === col.table && t.column === col.column),
      )
      .map((col) => `${col.table}.${col.column}`);
    expect(outside).toEqual([]);
  });

  it('ninguna vista de public salta la RLS (security_invoker o lista blanca)', async () => {
    const views = await raw.$queryRaw<View[]>`
      SELECT c.relname AS view, c.relkind::text AS kind, c.reloptions AS options
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      ORDER BY 1`;
    const offenders = views
      .filter((v) => !(v.view in VIEW_EXEMPT))
      .filter(
        (v) =>
          v.kind === 'm' ||
          !(v.options ?? []).includes('security_invoker=true'),
      )
      .map((v) => `${v.view} (${v.kind === 'm' ? 'materializada' : 'vista'})`);
    expect(offenders).toEqual([]);
  });

  it('cada exención de la lista blanca existe y sigue sin RLS', () => {
    for (const table of Object.keys(RLS_EXEMPT)) {
      const found = rls.find((t) => t.table === table);
      // Si la tabla ya no existe, no es de clínica o ya tiene RLS, la
      // exención sobra: quítala.
      expect({
        table,
        clinic: clinicTableNames().includes(table),
        rls: found?.rls,
      }).toEqual({ table, clinic: true, rls: false });
    }
  });

  it('DX-220: las tablas de plataforma existen, no tienen tenant y siguen sin RLS', () => {
    for (const table of Object.keys(PLATFORM_TABLES)) {
      const found = rls.find((t) => t.table === table);
      // Si ahora tiene tenant pasa a ser de clínica: o RLS o RLS_EXEMPT.
      expect({
        table,
        exists: found !== undefined,
        clinic: clinicTableNames().includes(table),
        rls: found?.rls,
      }).toEqual({ table, exists: true, clinic: false, rls: false });
    }
  });

  it('toda tabla de clínica tiene RLS activada y forzada', () => {
    const offenders = [...new Set(checked().map((t) => t.table))]
      .map((table) => rls.find((t) => t.table === table) as TableRls)
      .filter((t) => !t.rls || !t.forced)
      .map((t) => `${t.table} (rls=${t.rls}, force=${t.forced})`);
    expect(offenders).toEqual([]);
  });

  it('ninguna tabla de public con RLS activada queda sin FORZAR, sea o no de clínica (DX-113)', () => {
    // Las migraciones 2026…_dx113_unforce_* quitan FORCE durante una
    // migración de datos y su pareja _reforce_* lo devuelve. Si una pareja se
    // descuadra (o una migración falla a medias y el deploy no se repite), el
    // owner de las migraciones se saltaría la RLS: aquí se ve.
    const offenders = rls
      .filter((t) => t.rls && !t.forced)
      .map((t) => t.table)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('toda tabla de clínica tiene una política que la ata al tenant del contexto al leer y al escribir', () => {
    const offenders = checked()
      .filter(
        (t) =>
          !policies.some(
            (p) =>
              p.table === t.table &&
              p.cmd === 'ALL' &&
              p.permissive === 'PERMISSIVE' &&
              p.using === tenantPredicate(t.column) &&
              p.check === tenantPredicate(t.column),
          ),
      )
      .map((t) => `${t.table}.${t.column}`);
    expect(offenders).toEqual([]);
  });

  it('ninguna política permisiva extra abre una tabla de clínica', () => {
    // Las políticas PERMISSIVE se combinan con OR: una segunda política
    // (p. ej. USING (true)) anularía la de tenant.
    const extra = policies
      .filter((p) => p.permissive === 'PERMISSIVE')
      .filter((p) => {
        const exempt = POLICY_EXEMPT[`${p.table}.${p.policy}`];
        return !(
          exempt &&
          exempt.cmd === p.cmd &&
          JSON.stringify(exempt.roles) === JSON.stringify(p.roles)
        );
      })
      .filter((p) => {
        const columns = clinic
          .filter((t) => t.table === p.table)
          .map((t) => tenantPredicate(t.column));
        return (
          columns.length > 0 &&
          !(columns.includes(p.using ?? '') && p.check === p.using)
        );
      })
      .map((p) => `${p.table}.${p.policy}`);
    expect(extra).toEqual([]);
  });

  it('las políticas restrictivas son exactamente las esperadas (DX-144)', () => {
    const restrictive = Object.fromEntries(
      policies
        .filter((p) => p.permissive === 'RESTRICTIVE')
        .map((p) => [
          `${p.table}.${p.policy}`,
          { cmd: p.cmd, roles: p.roles, using: p.using },
        ]),
    );
    expect(restrictive).toEqual(
      Object.fromEntries(
        Object.entries(RESTRICTIVE_POLICIES).map(([key, p]) => [
          key,
          { cmd: p.cmd, roles: p.roles, using: p.using },
        ]),
      ),
    );
  });

  it('el rol de la app (DATABASE_URL) no es superusuario ni salta la RLS', async () => {
    const appUser = new URL(process.env.DATABASE_URL ?? '').username;
    const [role] = await raw.$queryRaw<
      { super: boolean; bypass: boolean }[]
    >`SELECT rolsuper AS super, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = ${appUser}`;
    expect(role).toEqual({ super: false, bypass: false });
  });
});
