import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-275: «Tiempos» solo añade un índice parcial de citas atendidas por sede
// e inicio con las horas del flujo en el INCLUDE. CONCURRENTLY y solo en su
// fichero (lint de DX-148); sin columnas nuevas de pacientes, así que
// dx_merge_patients (DX-266) no cambia.
const MIGRATION = '20270205140000_dx275_appointments_completed_timing_idx';

const code = (): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

describe('DX-275: migración aditiva', () => {
  it('una sola sentencia: el índice nuevo, CONCURRENTLY e idempotente', () => {
    const sql = code();
    expect(sql.split(';').filter((s) => s.trim())).toHaveLength(1);
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_location_start_completed_idx" ON "appointments" ("tenantId", "locationId", "start") INCLUDE ("providerId", "appointmentTypeId", "end", "arrivedAt", "seatedAt", "readyForCheckoutAt") WHERE "status" = \'COMPLETED\' AND "deletedAt" IS NULL;',
    );
  });

  it('nada destructivo ni de pacientes', () => {
    expect(code()).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i);
    expect(code()).not.toContain('"patients"');
  });
});
