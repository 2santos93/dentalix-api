// DX-251 (OPS-037): toda expresión que convierte `app.current_tenant` a uuid
// debe tolerar el valor VACÍO: `NULLIF(current_setting('app.current_tenant',
// true), '')::uuid`.
//
// Por qué: `set_config('app.current_tenant', …, true)` dura lo que la
// transacción, pero al terminar la variable NO vuelve a NULL: queda en '' el
// resto de la sesión. `prisma migrate deploy` aplica todas las migraciones en
// una sola sesión, así que tras un backfill que fija la clínica (DX-225) las
// siguientes corren con ''. Un `''::uuid` lanza 22P02 en cuanto la política
// se evalúa sobre una fila (p. ej. la validación de una FK hacia una tabla con
// FORCE, DX-151), y el despliegue se queda a medias. Con NULLIF la política
// compara con NULL y NIEGA la fila, igual que sin clínica fijada: nunca abre.
//
// Las migraciones hasta TENANT_GUC_NULLIF_FROM (incluida) quedan fuera: las
// dos de DX-251 reescriben todas las políticas existentes y la función que
// crea las de las particiones de audit_events. Las ya aplicadas no se editan.

export interface MigrationSource {
  name: string;
  sql: string;
}

export interface BareTenantCast {
  migration: string;
  line: number;
  expression: string;
}

/** Última migración que puede contener el cast sin NULLIF (la reescribe). */
export const TENANT_GUC_NULLIF_FROM =
  '20261020230000_dx251_rls_tenant_guc_nullif_rest';

/**
 * `current_setting('app.current_tenant'[, true|false])::uuid`, con o sin
 * `pg_catalog.`, con o sin `::text`, con o sin paréntesis alrededor y con las
 * comillas dobladas de
 * un SQL dinámico (`format('… current_setting(''app.current_tenant'', true)
 * ::uuid …')`). La forma con NULLIF no casa: tras el `)` viene `, '')`.
 */
const BARE_CAST =
  /current_setting\(\s*('{1,2})app\.current_tenant\1(?:\s*::\s*text)?(?:\s*,\s*(?:true|false))?\s*\)\s*\)?\s*::\s*uuid/gi;

/** Quita los comentarios `-- …` conservando los saltos de línea. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

export function findBareTenantCasts(
  migrations: MigrationSource[],
): BareTenantCast[] {
  const found: BareTenantCast[] = [];
  for (const m of migrations) {
    if (m.name <= TENANT_GUC_NULLIF_FROM) continue;
    const sql = stripLineComments(m.sql);
    for (const hit of sql.matchAll(BARE_CAST)) {
      found.push({
        migration: m.name,
        line: sql.slice(0, hit.index).split('\n').length,
        expression: hit[0],
      });
    }
  }
  return found;
}

export function formatBareTenantCasts(found: BareTenantCast[]): string {
  return found
    .map(
      (f) =>
        `${f.migration}/migration.sql:${f.line}: \`${f.expression}\` lanza 22P02 si ` +
        `app.current_tenant quedó en '' (tras un set_config local en la misma sesión de ` +
        `migrate deploy). Usa NULLIF(current_setting('app.current_tenant', true), '')::uuid (DX-251, OPS-037).`,
    )
    .join('\n');
}
