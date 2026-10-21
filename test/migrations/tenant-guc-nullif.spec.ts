import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TENANT_GUC_NULLIF_FROM,
  findBareTenantCasts,
  formatBareTenantCasts,
  type MigrationSource,
} from './tenant-guc-nullif';

// DX-251 (OPS-037): las políticas (y cualquier SQL de migración) convierten
// `app.current_tenant` a uuid con NULLIF, para que el '' que deja un
// set_config local en la sesión de `migrate deploy` niegue filas en vez de
// tumbar el despliegue con 22P02. Ver tenant-guc-nullif.ts.

const m = (name: string, sql: string): MigrationSource => ({ name, sql });
const NEW = '20990101000000_nueva';

describe('findBareTenantCasts (DX-251)', () => {
  it('avisa del cast directo en una política nueva, con su línea', () => {
    const found = findBareTenantCasts([
      m(
        NEW,
        `CREATE TABLE "x" ("tenantId" UUID);\nCREATE POLICY "tenant_isolation" ON "x"\n  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid);`,
      ),
    ]);
    expect(found).toEqual([
      {
        migration: NEW,
        line: 3,
        expression: "current_setting('app.current_tenant', true)::uuid",
      },
    ]);
    expect(formatBareTenantCasts(found)).toContain(
      "NULLIF(current_setting('app.current_tenant', true), '')::uuid",
    );
  });

  it('acepta la forma con NULLIF', () => {
    expect(
      findBareTenantCasts([
        m(
          NEW,
          `CREATE POLICY p ON "x" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
             WITH CHECK ("tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid);`,
        ),
      ]),
    ).toEqual([]);
  });

  it('caza pg_catalog., paréntesis, espacios, sin missing_ok y SQL dinámico con comillas dobladas', () => {
    const sql = [
      `SELECT pg_catalog.current_setting('app.current_tenant', true)::uuid;`,
      `SELECT (current_setting( 'app.current_tenant' , true ))::uuid;`,
      `SELECT current_setting('app.current_tenant') :: uuid;`,
      `SELECT (current_setting('app.current_tenant'::text, true))::uuid;`,
      `EXECUTE format('CREATE POLICY p ON %s USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid)', r);`,
    ].join('\n');
    expect(findBareTenantCasts([m(NEW, sql)]).map((f) => f.line)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('ignora comentarios y otras variables', () => {
    const sql = `-- antes: current_setting('app.current_tenant', true)::uuid
      SELECT current_setting('app.other', true)::uuid;
      SELECT coalesce(current_setting('app.current_tenant', true), '') <> '';`;
    expect(findBareTenantCasts([m(NEW, sql)])).toEqual([]);
  });

  it('no mira las migraciones hasta la de DX-251 (incluida): esas las reescribe ella', () => {
    const sql = `CREATE POLICY p ON "x" USING ("tenantId" = current_setting('app.current_tenant', true)::uuid);`;
    expect(
      findBareTenantCasts([
        m('20261020200100_dx151_patient_documents', sql),
        m(TENANT_GUC_NULLIF_FROM, sql),
      ]),
    ).toEqual([]);
  });
});

describe('prisma/migrations: app.current_tenant vacío no rompe el cast (DX-251)', () => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const migrations: MigrationSource[] = readdirSync(dir, {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) =>
      m(name, readFileSync(join(dir, name, 'migration.sql'), 'utf8')),
    );

  it('ninguna migración posterior a DX-251 convierte app.current_tenant a uuid sin NULLIF', () => {
    const found = findBareTenantCasts(migrations);
    if (found.length > 0) {
      throw new Error(formatBareTenantCasts(found));
    }
  });

  it('existen las dos migraciones de DX-251 que reescriben las políticas, antes de DX-151 y al final', () => {
    const names = migrations.map((x) => x.name);
    const first = '20261020200050_dx251_rls_tenant_guc_nullif';
    expect(names).toContain(first);
    expect(names).toContain(TENANT_GUC_NULLIF_FROM);
    // La primera va ANTES de la FK de patient_documents contra patients
    // (FORCE): en un despliegue desde cero esa FK se valida con ''.
    expect(first < '20261020200100_dx151_patient_documents').toBe(true);
    expect(existsSync(join(dir, first, 'migration.sql'))).toBe(true);
    // La segunda va después de todas las que crearon políticas con el cast
    // directo (DX-151, DX-153, DX-233).
    const withBare = migrations.filter((x) =>
      /current_setting\('app\.current_tenant', true\)::uuid/.test(x.sql),
    );
    expect(withBare.length).toBeGreaterThan(0);
    expect(withBare.every((x) => x.name <= TENANT_GUC_NULLIF_FROM)).toBe(true);
  });
});
