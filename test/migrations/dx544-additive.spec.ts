import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-544: expediente de rayos X por sede. Aditivas: un valor de enum, dos
// enums y una tabla nuevos, un índice ÚNICO trivial sobre equipment (id ya es
// la PK) y el índice parcial de auditoría. Nada se borra, renombra, cambia de
// tipo ni recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUMS = '20261127090000_dx544_enums';
const TABLE = '20261127090100_dx544_radiology_records';
const AUDIT = '20261127090200_dx544_audit_events_idx';

describe('DX-544: migraciones aditivas', () => {
  it.each([ENUMS, TABLE, AUDIT])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it.each([ENUMS, TABLE, AUDIT])(
    '%s solo añade: no borra, renombra, cambia columnas ni recorre filas',
    (m) => {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|ADD\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER/im,
      );
    },
  );

  it('sobre una tabla existente solo crea el índice único destino de la FK', () => {
    const touchesExisting = [
      ...code(TABLE).matchAll(/\bON\s+"(\w+)"\s*\(/g),
    ].map((m) => m[1]);
    expect(new Set(touchesExisting)).toEqual(
      new Set(['equipment', 'radiology_records']),
    );
    expect(code(TABLE)).toContain(
      'CREATE UNIQUE INDEX "equipment_tenant_location_id_key"\n  ON "equipment"("tenantId", "locationId", "id");',
    );
    expect(code(TABLE)).not.toMatch(/ALTER TABLE "(?!radiology_records")/);
  });

  it('la tabla nueva nace con RLS ENABLE + FORCE y sin DELETE para la app', () => {
    expect(code(TABLE)).toContain(
      'ALTER TABLE "radiology_records" ENABLE ROW LEVEL SECURITY;',
    );
    expect(code(TABLE)).toContain(
      'ALTER TABLE "radiology_records" FORCE ROW LEVEL SECURITY;',
    );
    expect(code(TABLE)).toContain(
      'REVOKE DELETE, TRUNCATE ON "radiology_records" FROM dentalix_app;',
    );
  });
});
