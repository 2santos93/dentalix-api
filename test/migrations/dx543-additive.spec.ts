import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-543: un índice parcial nuevo sobre `equipment` para los avisos de «Mi
// día». Aditiva: solo crea el índice; lock_timeout antes de la primera
// sentencia (como DX-542).

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const MIGRATION = '20261125090000_dx543_equipment_active_idx';

describe('DX-543: migración aditiva', () => {
  it('fija lock_timeout antes de la primera sentencia', () => {
    expect(code(MIGRATION)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('solo crea el índice parcial de los equipos activos', () => {
    expect(
      code(MIGRATION)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      'CREATE INDEX IF NOT EXISTS "equipment_tenant_active_location_idx" ON "equipment"("tenantId", "locationId") WHERE "status" = \'ACTIVE\';',
    );
  });
});
