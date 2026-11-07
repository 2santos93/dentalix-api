import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-513-ter: el índice parcial de la rama «rebaja de convenio» del informe
// de descuentos se rehace CONCURRENTLY con las dos ramas nuevas (la base
// congelada en la moneda del plan y el convenio sin referencia comparable).
// Sin columnas nuevas: nada se rellena ni se borra; ningún importe cambia.

const DIR = join(__dirname, '../../prisma/migrations');
const code = (migration: string): string =>
  readFileSync(join(DIR, migration, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

const CREATE_IDX = '20261202090000_dx513t_agreement_ref_reduction_idx';
const DROP_IDX = '20261202090100_dx513t_agreement_reduction_idx_drop_old';

describe('DX-513-ter: el índice de convenio rehecho', () => {
  it('primero el nuevo y luego se quita el anterior (nunca sin índice), una sentencia por migración', () => {
    expect(CREATE_IDX < DROP_IDX).toBe(true);
    const create = code(CREATE_IDX);
    expect(create.split(';').filter((st) => st.trim())).toHaveLength(1);
    expect(create).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "treatment_plan_items_tenant_agreement_ref_reduction_at_idx" ON "treatment_plan_items" ("tenantId", (COALESCE("discountAt", "createdAt"))) WHERE "agreementId" IS NOT NULL AND ("basePrice" > "catalogPrice" OR "basePriceInPlan" > "referencePriceInPlan" OR ("basePriceInPlan" IS NULL AND "basePrice" IS NOT NULL AND "catalogCurrency" IS NOT NULL AND "referenceCurrency" IS DISTINCT FROM "catalogCurrency")) AND "deletedAt" IS NULL;',
    );
    expect(code(DROP_IDX)).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "treatment_plan_items_tenant_agreement_reduction_at_idx";',
    );
  });

  it.each([CREATE_IDX, DROP_IDX])(
    '%s: sin lock_timeout (DB-078), sin cambios de datos y con la receta de recuperación',
    (m) => {
      const raw = readFileSync(join(DIR, m, 'migration.sql'), 'utf8');
      expect(code(m)).not.toMatch(
        /lock_timeout|ALTER\s+TABLE|^\s*UPDATE\b|DELETE\s+FROM|TRUNCATE/im,
      );
      expect(raw.replace(/\n--\s*/g, ' ')).toContain(
        `npx prisma migrate resolve --rolled-back ${m}`,
      );
    },
  );

  it('existen, van seguidas y en orden, después de las de DX-513-bis', () => {
    const all = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    // Por nombre, no por posición: migraciones posteriores no lo rompen.
    const at = all.indexOf(CREATE_IDX);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(all.slice(at, at + 2)).toEqual([CREATE_IDX, DROP_IDX]);
    expect(
      CREATE_IDX > '20261201090300_dx513b_effective_discount_idx_drop_old',
    ).toBe(true);
  });
});
