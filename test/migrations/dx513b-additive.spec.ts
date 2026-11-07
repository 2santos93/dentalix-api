import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-513-bis: la foto de la referencia en la moneda del plan. Aditiva: siete
// columnas NULL sin DEFAULT, dos CHECK y una FK NOT VALID (las valida la
// segunda, con NO FORCE / FORCE como DX-502), un trigger que congela la foto y
// el índice parcial del informe rehecho CONCURRENTLY con la referencia
// convertida. Nada se rellena ni se borra; ningún importe cambia.

const DIR = join(__dirname, '../../prisma/migrations');
const code = (migration: string): string =>
  readFileSync(join(DIR, migration, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20261201090000_dx513b_plan_item_reference_snapshot';
const VALIDATE = '20261201090100_dx513b_plan_item_reference_validate';
const CREATE_IDX = '20261201090200_dx513b_effective_ref_discount_idx';
const DROP_IDX = '20261201090300_dx513b_effective_discount_idx_drop_old';

describe('DX-513-bis: migraciones aditivas', () => {
  it.each([ADD, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera solo añade columnas NULL, restricciones NOT VALID y el trigger: no rellena, borra ni cambia importes', () => {
    const sql = code(ADD);
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|\bDEFAULT\b|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE|DISABLE\s+TRIGGER|SECURITY\s+DEFINER|FORCE\s+ROW|BYPASSRLS/im,
    );
    for (const column of [
      '"referenceCurrency" CHAR(3)',
      '"referencePriceInPlan" DECIMAL(12,2)',
      '"basePriceInPlan" DECIMAL(12,2)',
      '"referenceRateFrom" DECIMAL(18,8)',
      '"referenceRateTo" DECIMAL(18,8)',
      '"referenceRateSource" "ExchangeRateSource"',
      '"referenceRateDate" DATE',
    ]) {
      expect(sql).toContain(`ADD COLUMN ${column}`);
    }
    expect(sql.match(/NOT VALID;/g)).toHaveLength(3);
    expect(sql).toContain(
      'CREATE TRIGGER "treatment_plan_items_reference_frozen"',
    );
  });

  it('la segunda valida exactamente esas restricciones, con NO FORCE / FORCE en la misma transacción', () => {
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .split(';')
        .map((st) => st.trim())
        .filter(Boolean),
    ).toEqual([
      'ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_rate_check"',
      'ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_price_check"',
      'ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_currency_fkey"',
      'ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY',
    ]);
  });

  it('el índice se rehace CONCURRENTLY: primero el nuevo y luego se quita el anterior (nunca sin índice), una sentencia por migración', () => {
    expect(CREATE_IDX < DROP_IDX).toBe(true);
    const create = code(CREATE_IDX);
    expect(create.split(';').filter((st) => st.trim())).toHaveLength(1);
    expect(create).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "treatment_plan_items_tenant_effective_ref_discount_at_idx"/,
    );
    expect(create).toContain(
      'WHERE ("discount" > 0 OR "price" < "catalogPrice" OR "price" < "referencePriceInPlan") AND "deletedAt" IS NULL',
    );
    expect(code(DROP_IDX)).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "treatment_plan_items_tenant_effective_discount_at_idx";',
    );
  });

  it.each([CREATE_IDX, DROP_IDX])(
    '%s: sin lock_timeout (DB-078) y con la receta de recuperación (migrate resolve --rolled-back)',
    (m) => {
      const raw = readFileSync(join(DIR, m, 'migration.sql'), 'utf8');
      expect(code(m)).not.toMatch(/lock_timeout/);
      expect(raw.replace(/\n--\s*/g, ' ')).toContain(
        `npx prisma migrate resolve --rolled-back ${m}`,
      );
    },
  );

  it('la validación avisa del ACCESS EXCLUSIVE de NO FORCE hasta el COMMIT', () => {
    const raw = readFileSync(join(DIR, VALIDATE, 'migration.sql'), 'utf8');
    expect(raw).toMatch(/ACCESS\s+(--\s*)?EXCLUSIVE/);
    expect(raw).not.toMatch(/no bloquea lecturas ni escrituras/);
  });

  it('van después de la última migración anterior de main y en orden', () => {
    const all = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const mine = [ADD, VALIDATE, CREATE_IDX, DROP_IDX];
    expect(all.slice(-4)).toEqual(mine);
    expect(ADD > '20261130090000_dx133b_appointment_type_name_ci').toBe(true);
  });
});
