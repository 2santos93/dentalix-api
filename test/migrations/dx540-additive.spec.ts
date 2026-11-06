import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-540: registro profesional del autor en la evolución y aviso de la
// clínica. Aditivas: dos columnas nuevas (una nullable, otra con DEFAULT
// constante, sin reescribir la tabla en Postgres ≥ 11) y un CHECK NOT VALID
// que se valida en la siguiente migración (DB-029). Nada se borra, renombra
// ni recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20261123090000_dx540_clinical_entry_author_license';
const VALIDATE = '20261123090100_dx540_clinical_entry_author_license_validate';

describe('DX-540: migraciones aditivas', () => {
  it.each([ADD, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera solo añade: no borra, renombra, cambia tipos, recorre filas ni valida', () => {
    expect(code(ADD)).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE|DISABLE\s+TRIGGER/im,
    );
    expect(code(ADD)).toContain(
      'ALTER TABLE "clinical_entries" ADD COLUMN "authorProfessionalLicense" TEXT;',
    );
    expect(code(ADD)).toContain(
      'ALTER TABLE "tenants" ADD COLUMN "clinicalEntryLicenseWarning" BOOLEAN NOT NULL DEFAULT false;',
    );
  });

  it('el CHECK nuevo va NOT VALID y la segunda valida exactamente ese', () => {
    const added = [
      ...code(ADD).matchAll(
        /ADD CONSTRAINT "(\w+)"\s+CHECK \(([\s\S]*?)\) NOT VALID;/g,
      ),
    ].map((m) => m[1]);
    expect(added).toEqual([
      'clinical_entries_author_professional_license_check',
    ]);
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(
          'ALTER TABLE "clinical_entries" VALIDATE CONSTRAINT "clinical_entries_author_professional_license_check";',
          '',
        )
        .trim(),
    ).toBe('');
  });
});
