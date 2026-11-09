import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-417: la aceptación parcial enlaza el plan pendiente con su original
// (`treatment_plans.splitFromPlanId`, escritura única) y guarda en la
// aceptación qué quedó pendiente (columnas fuera del contenido firmado).
// Columnas NULL, CHECK y FK NOT VALID + VALIDATE aparte, con NO FORCE/FORCE
// alrededor de las FK (DX-134). NO es solo aditiva: reemplaza
// `treatment_plan_items_locked_when_accepted` para mirar también el plan de
// origen. El comportamiento, en test/treatment-plan-partial-acceptance.int-spec.ts.

const DIR = join(__dirname, '../../prisma/migrations');
const ADD = '20261207090000_dx417_partial_acceptance';
const VALIDATE = '20261207090100_dx417_partial_acceptance_validate';
const PREVIOUS_LOCK = '20261020230300_dx105_plan_item_pricing_snapshot';
const raw = (m: string) => readFileSync(join(DIR, m, 'migration.sql'), 'utf8');
const code = (m: string) =>
  raw(m)
    .replace(/--[^\n]*/g, '')
    .trim();

/** El cuerpo de una función plpgsql (entre los `$$`). */
const functionBody = (sql: string, name: string): string => {
  const at = sql.indexOf(`FUNCTION public."${name}"()`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = sql.indexOf('$$', at) + 2;
  return sql.slice(start, sql.indexOf('$$', start));
};

describe('DX-417: migración de la aceptación parcial', () => {
  it.each([ADD, VALIDATE])('%s fija lock_timeout antes que nada', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('no borra, renombra, rellena ni cambia columnas existentes', () => {
    for (const m of [ADD, VALIDATE]) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|^\s*UPDATE\b|DELETE\s+FROM|TRUNCATE|SECURITY\s+DEFINER|BYPASSRLS/im,
      );
    }
    // El VALIDATE no crea ni reemplaza nada.
    expect(code(VALIDATE)).not.toMatch(/TRIGGER|FUNCTION|ADD COLUMN/);
  });

  it('las columnas nuevas son NULL sin default y las restricciones nacen NOT VALID', () => {
    const add = code(ADD);
    for (const column of [
      '"splitFromPlanId" UUID,',
      '"pendingPlanId" UUID,',
      '"pendingItemIds" UUID[],',
      '"pendingTotal" NUMERIC(14, 2),',
    ]) {
      expect(add).toContain(`ADD COLUMN ${column}`);
    }
    expect(add).not.toMatch(/NOT NULL\s*,|DEFAULT/);
    expect(add.match(/NOT VALID/g)).toHaveLength(4);
  });

  it('las dos FK son compuestas (clínica, plan y paciente) y NO ACTION', () => {
    const add = code(ADD);
    expect(add).toContain(
      'FOREIGN KEY ("tenantId", "splitFromPlanId", "patientId")\n    REFERENCES "treatment_plans"("tenantId", "id", "patientId")\n    ON DELETE NO ACTION ON UPDATE NO ACTION',
    );
    expect(add).toContain(
      'FOREIGN KEY ("tenantId", "pendingPlanId", "patientId")\n    REFERENCES "treatment_plans"("tenantId", "id", "patientId")\n    ON DELETE NO ACTION ON UPDATE NO ACTION',
    );
  });

  it('cada FK tiene su índice ÚNICO parcial en el lado hijo (un pendiente por plan)', () => {
    const add = code(ADD);
    expect(add).toContain(
      'CREATE UNIQUE INDEX "treatment_plans_split_from_key"\n  ON "treatment_plans"("tenantId", "splitFromPlanId")\n  WHERE "splitFromPlanId" IS NOT NULL;',
    );
    expect(add).toContain(
      'CREATE UNIQUE INDEX "treatment_plan_acceptances_pending_plan_key"\n  ON "treatment_plan_acceptances"("tenantId", "pendingPlanId")\n  WHERE "pendingPlanId" IS NOT NULL;',
    );
  });

  it('el enlace es de escritura única (trigger BEFORE UPDATE OF con search_path fijo)', () => {
    const add = code(ADD);
    expect(add).toContain(
      'CREATE TRIGGER "treatment_plans_split_from_immutable"\n  BEFORE UPDATE OF "splitFromPlanId" ON "treatment_plans"',
    );
    expect(functionBody(add, 'treatment_plans_split_from_immutable')).toContain(
      'IF NEW."splitFromPlanId" IS DISTINCT FROM OLD."splitFromPlanId" THEN',
    );
    expect(add.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(3);
  });

  it('M-4: la aceptación solo nombra un pendiente que viene de su plan (constraint trigger al alta)', () => {
    const add = code(ADD);
    expect(add).toContain(
      'CREATE CONSTRAINT TRIGGER "treatment_plan_acceptances_pending_link"\n  AFTER INSERT ON "treatment_plan_acceptances"',
    );
    const body = functionBody(add, 'treatment_plan_acceptances_pending_link');
    expect(body).toContain('p."splitFromPlanId" = NEW."planId"');
    expect(body).toContain('p."tenantId" = NEW."tenantId"');
  });

  it('el bloqueo de un plan firmado mira también el plan de ORIGEN y no cambia nada más', () => {
    const now = functionBody(
      code(ADD),
      'treatment_plan_items_locked_when_accepted',
    );
    const before = functionBody(
      code(PREVIOUS_LOCK),
      'treatment_plan_items_locked_when_accepted',
    );
    const opens =
      'IF TG_OP = \'UPDATE\' AND NEW."planId" IS DISTINCT FROM OLD."planId" THEN';
    const from = now.indexOf(opens);
    const to =
      now.indexOf('END IF;\n  END IF;', from) + 'END IF;\n  END IF;'.length;
    expect(from).toBeGreaterThan(0);
    const guard = now.slice(from, to);
    expect(guard).toContain('WHERE "id" = OLD."planId" FOR SHARE');
    expect(guard).toContain('WHERE "planId" = OLD."planId"');
    // Quitada la guarda nueva, la función es la vigente tal cual.
    const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    expect(squash(now.slice(0, from) + now.slice(to))).toBe(squash(before));
  });

  it('el VALIDATE: los CHECK primero con FORCE; solo las FK dentro del NO FORCE/FORCE', () => {
    const lines = code(VALIDATE)
      .split(';')
      .map((st) => st.trim())
      .filter(Boolean);
    expect(lines.slice(1)).toEqual([
      'ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_split_from_check"',
      'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_pending_check"',
      // M-2: en el orden en que la app las lee (plan, luego aceptación).
      'ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_split_from_fkey"',
      'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_pending_plan_fkey"',
      'ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY',
    ]);
  });

  it('documenta su vuelta atrás', () => {
    expect(raw(ADD)).toContain('Vuelta atrás');
    expect(raw(ADD)).toContain(PREVIOUS_LOCK);
    expect(raw(VALIDATE)).toContain('Vuelta atrás');
  });

  it('van seguidas y después de la aceptación de un vencido (DX-379 C)', () => {
    const all = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const at = all.indexOf(ADD);
    expect(at).toBeGreaterThan(
      all.indexOf('20261206090100_dx379c_expired_quote_acceptance_validate'),
    );
    expect(all.slice(at, at + 2)).toEqual([ADD, VALIDATE]);
  });
});
