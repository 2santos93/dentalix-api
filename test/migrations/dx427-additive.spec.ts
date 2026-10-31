import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-427: las CHECK de dosis, acumulado y hora se añaden NOT VALID en una
// migración (bloqueo de milisegundos) y se validan en la siguiente, cada una
// en su transacción (DB-029). Aditivas: no borran, renombran ni recorren
// filas; lock_timeout antes de la primera sentencia y las funciones de la
// guarda con SECURITY INVOKER y search_path fijo (SEC-032).

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const CHECKS = '20261107120000_dx427_anesthesia_sedation_checks';
const VALIDATE = '20261107120100_dx427_anesthesia_sedation_validate';

describe('DX-427: migraciones aditivas', () => {
  it.each([CHECKS, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera no borra, renombra, cambia tipos, recorre filas ni valida', () => {
    expect(code(CHECKS)).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE/im,
    );
  });

  it('cada CHECK nuevo va NOT VALID y la segunda valida exactamente esos', () => {
    const added = [
      ...code(CHECKS).matchAll(
        /ADD CONSTRAINT "(\w+)"\s+CHECK \(([\s\S]*?)\) NOT VALID;/g,
      ),
    ].map((m) => m[1]);
    const all = [...code(CHECKS).matchAll(/ADD CONSTRAINT "(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(added).toHaveLength(9);
    expect(added).toEqual(all);
    const validated = [
      ...code(VALIDATE).matchAll(/VALIDATE CONSTRAINT "(\w+)";/g),
    ].map((m) => m[1]);
    expect(validated).toEqual(added);
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/ALTER TABLE "\w+" VALIDATE CONSTRAINT "\w+";/g, '')
        .trim(),
    ).toBe('');
  });

  it('las funciones de la guarda son SECURITY INVOKER con search_path fijo y SQLSTATE propio', () => {
    const sql = code(CHECKS);
    for (const fn of [
      'dx427_anesthesia_not_before_entry',
      'dx427_sedation_not_before_entry',
    ]) {
      expect(sql).toContain(
        `CREATE FUNCTION public.${fn}() RETURNS trigger\n  LANGUAGE plpgsql\n  SET search_path = pg_catalog, pg_temp`,
      );
    }
    expect(sql).not.toMatch(/SECURITY\s+DEFINER|CREATE\s+OR\s+REPLACE/i);
    expect(sql.match(/ERRCODE = 'Q4270'/g)).toHaveLength(2);
  });
});
