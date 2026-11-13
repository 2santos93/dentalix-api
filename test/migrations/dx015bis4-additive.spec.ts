import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-015-bis (porción 4, D20): el tipo de cita al agendar de un tipo de
// recall. Aditiva: una columna nullable sin default, una FK compuesta NOT
// VALID y su índice parcial; la segunda solo valida esa FK con NO FORCE en
// las dos tablas (DX-134) y FORCE de vuelta. Nada se borra, renombra ni
// recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20261215090000_dx015bis_recall_type_appointment_type';
const VALIDATE =
  '20261215090100_dx015bis_recall_type_appointment_type_validate';

describe('DX-015-bis D20: migraciones aditivas', () => {
  it.each([ADD, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera solo añade: columna nullable, FK compuesta NOT VALID e índice', () => {
    expect(code(ADD)).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE|DISABLE\s+TRIGGER|\bDEFAULT\b/im,
    );
    expect(code(ADD)).toContain(
      'ALTER TABLE "recall_types" ADD COLUMN "appointmentTypeId" UUID;',
    );
    expect(code(ADD)).toMatch(
      /ADD CONSTRAINT "recall_types_appointment_type_fkey"\s+FOREIGN KEY \("tenantId", "appointmentTypeId"\)\s+REFERENCES "appointment_types"\("tenantId", "id"\)\s+ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;/,
    );
  });

  it('la segunda solo valida esa FK, con NO FORCE en la hija y en la referenciada', () => {
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .split(/;\s*/)
        .map((statement) => statement.trim())
        .filter(Boolean),
    ).toEqual([
      'ALTER TABLE "recall_types" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "appointment_types" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "recall_types" VALIDATE CONSTRAINT "recall_types_appointment_type_fkey"',
      'ALTER TABLE "recall_types" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "appointment_types" FORCE ROW LEVEL SECURITY',
    ]);
  });
});
