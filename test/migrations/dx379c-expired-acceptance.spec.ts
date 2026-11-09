import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-379 (porción C): la aceptación de un presupuesto vencido guarda cómo se
// aceptó en columnas nuevas de treatment_plan_acceptances (aditivas, NULL,
// fuera del contenido firmado). CHECK y FK NOT VALID + VALIDATE aparte, con
// NO FORCE/FORCE alrededor de la FK (DX-134). Los CHECK, en
// test/treatment-plan-expired-acceptance.int-spec.ts.

const DIR = join(__dirname, '../../prisma/migrations');
const ADD = '20261206090000_dx379c_expired_quote_acceptance';
const VALIDATE = '20261206090100_dx379c_expired_quote_acceptance_validate';
const raw = (m: string) => readFileSync(join(DIR, m, 'migration.sql'), 'utf8');
const code = (m: string) =>
  raw(m)
    .replace(/--[^\n]*/g, '')
    .trim();

describe('DX-379 (C): migración de la aceptación de un presupuesto vencido', () => {
  it.each([ADD, VALIDATE])('%s fija lock_timeout antes que nada', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('es aditiva: no borra, renombra, rellena ni toca triggers ni columnas existentes', () => {
    for (const m of [ADD, VALIDATE]) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|^\s*UPDATE\b|DELETE\s+FROM|TRUNCATE|TRIGGER|FUNCTION|SECURITY\s+DEFINER|BYPASSRLS/im,
      );
    }
  });

  it('las columnas nuevas son NULL sin default y las restricciones nacen NOT VALID', () => {
    const add = code(ADD);
    for (const column of [
      '"quoteValidUntil" DATE,',
      '"expiredMode" "ExpiredQuoteAcceptanceMode",',
      '"expiredReason" "ExpiredQuoteAcceptanceReason",',
      '"expiredNote" TEXT,',
      '"repricingId" UUID,',
    ]) {
      expect(add).toContain(`ADD COLUMN ${column}`);
    }
    expect(add).not.toMatch(/NOT NULL\s*,|DEFAULT/);
    expect(add.match(/NOT VALID/g)).toHaveLength(3);
  });

  it('la FK de la recotización es compuesta (clínica, plan y paciente)', () => {
    expect(code(ADD)).toContain(
      'FOREIGN KEY ("tenantId", "repricingId", "planId", "patientId")\n    REFERENCES "treatment_plan_repricings"("tenantId", "id", "planId", "patientId")',
    );
  });

  it('el VALIDATE: los CHECK primero con FORCE; solo la FK dentro del NO FORCE/FORCE de las dos tablas', () => {
    const lines = code(VALIDATE)
      .split(';')
      .map((st) => st.trim())
      .filter(Boolean);
    expect(lines.slice(1)).toEqual([
      'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_check"',
      'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_note_check"',
      'ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_repricings" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_repricing_fkey"',
      'ALTER TABLE "treatment_plan_repricings" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY',
    ]);
  });

  it('la FK tiene su índice parcial en el lado hijo', () => {
    expect(code(ADD)).toContain(
      'CREATE INDEX "treatment_plan_acceptances_repricing_idx"\n  ON "treatment_plan_acceptances"("tenantId", "repricingId")\n  WHERE "repricingId" IS NOT NULL;',
    );
  });

  it('documenta su vuelta atrás', () => {
    expect(raw(ADD)).toContain('Vuelta atrás');
    expect(raw(VALIDATE)).toContain('Vuelta atrás');
  });

  it('van seguidas y después de la recotización (porción B)', () => {
    const all = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const at = all.indexOf(ADD);
    expect(at).toBeGreaterThan(
      all.indexOf('20261205090000_dx379b_plan_repricings'),
    );
    expect(all.slice(at, at + 2)).toEqual([ADD, VALIDATE]);
  });
});
