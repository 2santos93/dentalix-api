import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-560: presentación del plan al paciente. Tres migraciones aditivas: la
// descripción para el paciente del catálogo (jsonb NOT NULL DEFAULT '{}' con
// su CHECK validado en la misma sentencia, tabla pequeña), la presentación
// congelada de la solicitud de firma (jsonb nullable, CHECK NOT VALID y el
// guard con la columna nueva) y el VALIDATE aparte. Nada se borra, renombra
// ni recorre.

const read = (name: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const CATALOG = '20270110140000_dx560_catalog_patient_description';
const SIGNATURE = '20270110140100_dx560_signature_budget_presentation';
const VALIDATE = '20270110140200_dx560_validate';
const DX561 = '20270107140100_dx561_quote_follow_up';

const DESTRUCTIVE =
  /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|NO\s+FORCE|\bINDEX\b/im;

/** El cuerpo de `signature_requests_guard()` de una migración. */
function guardOf(sql: string): string {
  const start = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.signature_requests_guard()',
  );
  const end = sql.indexOf('$function$;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, end);
}

describe('DX-560: migraciones aditivas', () => {
  it.each([CATALOG, SIGNATURE, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia y no destruye nada',
    (name) => {
      const sql = read(name);
      expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/);
      expect(sql).not.toMatch(DESTRUCTIVE);
    },
  );

  it('el catálogo: columna con DEFAULT constante y CHECK de objeto y tamaño', () => {
    const sql = read(CATALOG).replace(/\s+/g, ' ');
    expect(sql).toContain(
      `ALTER TABLE "dental_catalog_items" ADD COLUMN "patientDescription" JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    expect(sql).toContain(
      `ADD CONSTRAINT "dental_catalog_items_patient_description_check" CHECK ( jsonb_typeof("patientDescription") = 'object' AND pg_column_size("patientDescription") <= 8192 );`,
    );
    expect(sql).not.toMatch(/NOT VALID/);
  });

  it('la solicitud: columna nullable sin DEFAULT y CHECK NOT VALID (solo BUDGET, objeto y tamaño)', () => {
    const sql = read(SIGNATURE).replace(/\s+/g, ' ');
    expect(sql).toContain(
      `ALTER TABLE "signature_requests" ADD COLUMN "budgetPresentation" JSONB;`,
    );
    expect(sql).toContain(
      `ADD CONSTRAINT "signature_requests_budget_presentation_check" CHECK ( "budgetPresentation" IS NULL OR ( "type" = 'BUDGET' AND jsonb_typeof("budgetPresentation") = 'object' AND pg_column_size("budgetPresentation") <= 262144 ) ) NOT VALID;`,
    );
    expect(read(VALIDATE).replace(/\s+/g, ' ')).toContain(
      `ALTER TABLE "signature_requests" VALIDATE CONSTRAINT "signature_requests_budget_presentation_check";`,
    );
  });

  it('el guard es el de DX-561 más la columna congelada (nada más cambia)', () => {
    const before = guardOf(read(DX561));
    const after = guardOf(read(SIGNATURE));
    expect(after).toContain(
      'OR NEW."budgetPresentation" IS DISTINCT FROM OLD."budgetPresentation"',
    );
    expect(
      after
        .replace(
          '     OR NEW."budgetPresentation" IS DISTINCT FROM OLD."budgetPresentation"\n',
          '',
        )
        .replace(', DX-560)', ')'),
    ).toBe(before);
  });
});
