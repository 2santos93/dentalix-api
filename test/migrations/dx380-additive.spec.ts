import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-380: las migraciones son aditivas y compatibles con las réplicas
// anteriores durante el despliegue escalonado: no borran ni renombran nada,
// no reescriben tablas calientes, las que bloquean fijan lock_timeout y los
// índices sobre tablas calientes son CONCURRENTLY, solos en su fichero.

const sql = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  );
const code = (migration: string): string =>
  sql(migration)
    .replace(/--[^\n]*/g, '')
    .trim();

const LOCKING = [
  '20261104120000_dx380_job_schedule_skips',
  '20261104120300_dx380_payment_base_retries',
];
const CONCURRENT: [string, string][] = [
  [
    '20261104120100_dx380_jobs_active_name_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_active_name_idx" ON "jobs" ("name") WHERE "state" IN ('PENDING', 'RUNNING');`,
  ],
  [
    '20261104120200_dx380_payments_tenant_id_key',
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "payments_tenant_id_key" ON "payments" ("tenantId", "id");',
  ],
];
const BACKFILL = '20261104120400_dx380_payment_base_retries_backfill';
const ALL = [...LOCKING, ...CONCURRENT.map(([m]) => m), BACKFILL];

describe('DX-380: migraciones aditivas', () => {
  it.each(ALL)('%s no borra, renombra ni cambia el tipo de nada', (m) => {
    expect(code(m)).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM/im,
    );
  });

  it.each(LOCKING)(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it.each(CONCURRENT)(
    '%s es un índice concurrente, única sentencia del fichero',
    (m, statement) => {
      expect(
        code(m)
          .split(';')
          .filter((s) => s.trim()),
      ).toHaveLength(1);
      expect(code(m)).toBe(statement);
    },
  );

  it('job_schedules solo gana columnas con default o NULL', () => {
    expect(code(LOCKING[0])).toContain(
      'ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0',
    );
    expect(code(LOCKING[0])).toContain(
      'ADD COLUMN "lastSkippedAt" TIMESTAMP(3);',
    );
  });

  it('la tabla nueva lleva RLS FORCE con NULLIF y FK compuesta por clínica al abono', () => {
    const retries = code(LOCKING[1]);
    expect(retries).toContain(
      'FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments"("tenantId", "id")',
    );
    expect(retries).toContain(
      `USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`,
    );
    expect(retries).toContain(
      'ALTER TABLE "payment_base_retries" FORCE ROW LEVEL SECURITY;',
    );
    expect(retries).toContain(
      'CREATE INDEX "payment_base_retries_due_idx"\n  ON "payment_base_retries"("tenantId", "nextAttemptAt");',
    );
  });

  it('el relleno va por lotes con COMMIT, lock_timeout y el tenant de cada clínica', () => {
    const backfill = code(BACKFILL);
    expect(backfill).toContain(
      "pg_catalog.set_config('app.current_tenant', t::text, true)",
    );
    expect(backfill).toContain(
      "pg_catalog.set_config('lock_timeout', '5s', true)",
    );
    expect(backfill).toContain('LIMIT 2000');
    expect(backfill).toContain('COMMIT;');
    expect(backfill).toContain('ON CONFLICT DO NOTHING');
  });
});
