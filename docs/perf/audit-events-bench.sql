-- DX-102: benchmark reproducible de GET /audit-events sobre audit_events
-- particionada. SOLO en una BD desechable con todas las migraciones:
--   /home/user/wt/newdb.sh dentalix_bench && DIRECT_URL=... npx prisma migrate deploy
--   psql -h localhost -U postgres -d dentalix_bench -f docs/perf/audit-events-bench.sql
-- Carga 1,5 M eventos sintéticos (A: 1,2 M en 366 días; B: 0,3 M), y mide
-- como dentalix_app (RLS) las consultas que emite el repositorio.
\timing off
SELECT dx_audit_events_create_partition(m::date)
FROM generate_series(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '13 months',
                     date_trunc('month', now() AT TIME ZONE 'UTC'), interval '1 month') m;

INSERT INTO audit_events ("id","tenantId","actorUserId","actorRole","action","resourceType","patientId","requestId","ip","userAgent","occurredAt","metadata")
SELECT gen_random_uuid(),
       CASE WHEN g <= 1200000 THEN 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
            ELSE 'bbbbbbbb-0000-4000-8000-000000000002'::uuid END,
       ('00000000-0000-4000-8000-0000000000' || lpad((g % 30)::text, 2, '0'))::uuid,
       'ADMIN',
       (CASE WHEN g % 1000 = 0 THEN 'VOID' WHEN g % 10 = 0 THEN 'UPDATE' WHEN g % 25 = 0 THEN 'CREATE' ELSE 'VIEW' END)::"AuditAction",
       (CASE WHEN g % 1000 = 0 THEN 'PAYMENT' WHEN g % 7 = 0 THEN 'MEDICAL_HISTORY' WHEN g % 50 = 0 THEN 'ACCOUNT_STATEMENT' ELSE 'PATIENT' END)::"AuditResourceType",
       ('00000000-0000-4000-9000-' || lpad((g % 5000)::text, 12, '0'))::uuid,
       'req-' || g, '10.0.0.1', repeat('x', 80),
       (now() AT TIME ZONE 'UTC') - make_interval(secs => (g % 1200000) * 26.3),
       '{}'
FROM generate_series(1, 1500000) g;
ANALYZE audit_events;

SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS total, count(*) AS partitions
FROM pg_class c, pg_inherits i WHERE i.inhparent = 'audit_events'::regclass AND c.oid = i.inhrelid GROUP BY 1 LIMIT 0;

BEGIN;
SET LOCAL ROLE dentalix_app;
SELECT set_config('app.current_tenant', 'aaaaaaaa-0000-4000-8000-000000000001', true);
\echo '--- 1. página 1, últimos 30 días'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= (now() AT TIME ZONE 'UTC')::timestamp(3) - interval '30 days'
  AND "occurredAt" < (now() AT TIME ZONE 'UTC')::timestamp(3)
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
\echo '--- 2. cursor a ~6 meses (rango 366 días)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= '2025-10-16' AND "occurredAt" < '2026-10-17'
  AND "occurredAt" <= '2026-04-16 12:00:00'
  AND ("occurredAt" < '2026-04-16 12:00:00' OR ("occurredAt" = '2026-04-16 12:00:00' AND id < 'ffffffff-ffff-4fff-bfff-ffffffffffff'))
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
\echo '--- 2b. mismo cursor SIN occurredAt <= (forma DX-009)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= '2025-10-16' AND "occurredAt" < '2026-10-17'
  AND ("occurredAt" < '2026-04-16 12:00:00' OR ("occurredAt" = '2026-04-16 12:00:00' AND id < 'ffffffff-ffff-4fff-bfff-ffffffffffff'))
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
\echo '--- 3. action = VOID, 366 días'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= '2025-10-16' AND "occurredAt" < '2026-10-17'
  AND action = 'VOID'
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
\echo '--- 4. resourceType = ACCOUNT_STATEMENT, 366 días'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= '2025-10-16' AND "occurredAt" < '2026-10-17'
  AND "resourceType" = 'ACCOUNT_STATEMENT'
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
\echo '--- 5. paciente, 366 días'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM audit_events
WHERE "tenantId" = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND "occurredAt" >= '2025-10-16' AND "occurredAt" < '2026-10-17'
  AND "patientId" = '00000000-0000-4000-9000-000000000042'
ORDER BY "occurredAt" DESC, id DESC LIMIT 51;
ROLLBACK;
