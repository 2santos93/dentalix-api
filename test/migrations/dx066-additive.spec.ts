import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-066: umbrales de sondaje del periodontograma por clínica. Aditivas: dos
// columnas con DEFAULT constante en tenants (solo metadatos en Postgres ≥ 11)
// y un CHECK NOT VALID que se valida en la siguiente migración. Nada se
// borra, renombra ni recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20270208140000_dx066_perio_thresholds';
const VALIDATE = '20270208140100_dx066_perio_thresholds_validate';

describe('DX-066: migraciones aditivas', () => {
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
      'ADD COLUMN "perioPdAlertMm" SMALLINT NOT NULL DEFAULT 4',
    );
    expect(code(ADD)).toContain(
      'ADD COLUMN "perioPdSevereMm" SMALLINT NOT NULL DEFAULT 6',
    );
  });

  it('el CHECK nuevo va NOT VALID y la segunda valida exactamente ese', () => {
    const added = [
      ...code(ADD).matchAll(
        /ADD CONSTRAINT "(\w+)"\s+CHECK \(([\s\S]*?)\) NOT VALID;/g,
      ),
    ].map((m) => m[1]);
    expect(added).toEqual(['tenants_perio_pd_thresholds_check']);
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(
          'ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_perio_pd_thresholds_check";',
          '',
        )
        .trim(),
    ).toBe('');
  });
});
