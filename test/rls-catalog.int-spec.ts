import { PrismaClient } from '@prisma/client';

/**
 * DX-068 (TST-002): invariante de RLS leída del catálogo de Postgres.
 *
 * `rls.isolation.int-spec.ts` prueba el comportamiento en una tabla; este
 * spec fija la CONFIGURACIÓN de todas: cada tabla con columna "tenantId" debe
 * tener RLS activada (relrowsecurity) y FORZADA (relforcerowsecurity, si no el
 * owner que migra se la salta) y una política que ate "tenantId" al tenant del
 * contexto (`app.current_tenant`) tanto al leer (USING) como al escribir
 * (WITH CHECK). Una tabla nueva sin RLS rompe la CI aquí.
 *
 * Lee el catálogo por DIRECT_URL (owner): pg_class y pg_policies no dependen
 * de la RLS, pero así el spec no depende de los GRANT del rol de la app.
 */

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/**
 * Tablas con "tenantId" que NO llevan RLS, cada una con su motivo. Añadir una
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
};

// La forma exacta que generan las migraciones (ver p. ej. la de patients).
const TENANT_PREDICATE = `("tenantId" = (current_setting('app.current_tenant'::text, true))::uuid)`;

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
}

describe('Catálogo de RLS (DX-068)', () => {
  let tables: TableRls[];
  let policies: Policy[];

  beforeAll(async () => {
    tables = await raw.$queryRaw<TableRls[]>`
      SELECT c.relname AS table,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND a.attname = 'tenantId'
        AND NOT a.attisdropped
      ORDER BY c.relname`;
    policies = await raw.$queryRaw<Policy[]>`
      SELECT tablename AS table, policyname AS policy, cmd, permissive,
             qual AS using, with_check AS check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname`;
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it('encuentra las tablas de clínica (la consulta no está vacía)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(29);
    expect(tables.map((t) => t.table)).toEqual(
      expect.arrayContaining(['patients', 'payments', 'clinic_memberships']),
    );
  });

  it('cada exención de la lista blanca existe y sigue sin RLS', () => {
    for (const table of Object.keys(RLS_EXEMPT)) {
      const found = tables.find((t) => t.table === table);
      // Si la tabla ya no existe o ya tiene RLS, la exención sobra: quítala.
      expect({ table, exists: !!found, rls: found?.rls }).toEqual({
        table,
        exists: true,
        rls: false,
      });
    }
  });

  it('toda tabla con "tenantId" tiene RLS activada y forzada', () => {
    const offenders = tables
      .filter((t) => !(t.table in RLS_EXEMPT))
      .filter((t) => !t.rls || !t.forced)
      .map((t) => `${t.table} (rls=${t.rls}, force=${t.forced})`);
    expect(offenders).toEqual([]);
  });

  it('toda tabla con "tenantId" tiene una política que la ata al tenant del contexto al leer y al escribir', () => {
    const offenders = tables
      .filter((t) => !(t.table in RLS_EXEMPT))
      .filter(
        (t) =>
          !policies.some(
            (p) =>
              p.table === t.table &&
              p.cmd === 'ALL' &&
              p.permissive === 'PERMISSIVE' &&
              p.using === TENANT_PREDICATE &&
              p.check === TENANT_PREDICATE,
          ),
      )
      .map((t) => t.table);
    expect(offenders).toEqual([]);
  });

  it('ninguna política permisiva extra abre una tabla de clínica', () => {
    // Las políticas PERMISSIVE se combinan con OR: una segunda política
    // (p. ej. USING (true)) anularía la de tenant.
    const extra = policies
      .filter((p) => tables.some((t) => t.table === p.table))
      .filter((p) => p.permissive === 'PERMISSIVE')
      .filter(
        (p) => p.using !== TENANT_PREDICATE || p.check !== TENANT_PREDICATE,
      )
      .map((p) => `${p.table}.${p.policy}`);
    expect(extra).toEqual([]);
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
