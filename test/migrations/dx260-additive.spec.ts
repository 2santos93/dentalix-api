import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-260: «Retención» solo añade un índice parcial de citas atendidas con el
// profesional en el INCLUDE. CONCURRENTLY y solo en su fichero (lint de
// DX-148); sin columnas nuevas de pacientes, así que dx_merge_patients
// (DX-266) no cambia.
const MIGRATION = '20270203140000_dx260_appointments_completed_provider_idx';

const code = (): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

describe('DX-260: migración aditiva', () => {
  it('una sola sentencia: el índice nuevo, CONCURRENTLY e idempotente, con el predicado de DX-145', () => {
    const sql = code();
    expect(sql.split(';').filter((s) => s.trim())).toHaveLength(1);
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_patient_completed_provider_idx" ON "appointments" ("tenantId", "patientId", "start" DESC, "id" DESC) INCLUDE ("locationId", "providerId") WHERE "status" = \'COMPLETED\' AND "deletedAt" IS NULL;',
    );
  });

  it('nada destructivo ni de pacientes', () => {
    expect(code()).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i);
    expect(code()).not.toContain('"patients"');
  });
});
