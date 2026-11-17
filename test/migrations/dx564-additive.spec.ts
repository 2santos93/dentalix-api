import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-564: indicaciones previas a la cita por tipo de cita. Una migración
// aditiva: columna jsonb NOT NULL con DEFAULT constante '{}' y su CHECK de
// objeto y tamaño (patrón DX-517). Nada se borra, renombra ni recorre; el
// índice de nombre por expresión (DX-133-bis) no se toca.

const MIGRATION = '20270104090000_dx564_pre_visit_instructions';

const code = (): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

describe('DX-564: migración aditiva', () => {
  it('fija lock_timeout antes de la primera sentencia', () => {
    expect(code()).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('no borra, renombra, recorre ni toca columnas o índices existentes', () => {
    expect(code()).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|NO\s+FORCE|\bINDEX\b/im,
    );
  });

  it('añade la columna con DEFAULT constante y el CHECK de objeto y tamaño', () => {
    const sql = code().replace(/\s+/g, ' ');
    expect(sql).toContain(
      `ALTER TABLE "appointment_types" ADD COLUMN "preVisitInstructions" JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    expect(sql).toContain(
      `ADD CONSTRAINT "appointment_types_pre_visit_instructions_check" CHECK ( jsonb_typeof("preVisitInstructions") = 'object' AND pg_column_size("preVisitInstructions") <= 8192 );`,
    );
    expect(sql).not.toMatch(/NOT VALID/);
  });
});
