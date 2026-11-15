-- DX-569: índices parciales de audit_events para PAYMENT_LINK y
-- PAYMENT_REPORT.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Van en su PROPIA migración: los valores se añadieron en
-- 20261225090000_dx569_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- DX-148 («Migraciones en caliente», README): CREATE INDEX CONCURRENTLY no
-- se admite en una tabla particionada y el índice recursivo sobre el padre
-- bloquea todos los INSERT de auditoría. Plantilla ON ONLY + ATTACH: primero
-- el índice de cada partición (la del mes en curso y la DEFAULT, las que
-- reciben INSERT, al final), luego el del padre ON ONLY y el ATTACH de cada
-- partición; el padre queda válido al adjuntar la última. Las particiones
-- que se creen después heredan el índice.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261225090100_dx569_audit_events_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX "audit_events_resource_payment_link_idx",
-- "audit_events_resource_payment_report_idx".

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  part regclass;
  spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
      ('audit_events_resource_payment_link_idx', 'PAYMENT_LINK'),
      ('audit_events_resource_payment_report_idx', 'PAYMENT_REPORT')
    ) AS v(idx, resource)
  LOOP
    FOR part IN
      SELECT i.inhrelid::regclass FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'public.audit_events'::regclass
       ORDER BY (c.relname = 'audit_events_default'
                 OR c.relname >= 'audit_events_p' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMM')),
                c.relname
    LOOP
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %s ("tenantId", "occurredAt" DESC, "id" DESC) WHERE "resourceType" = %L',
        replace(spec.idx, 'audit_events', part::text), part, spec.resource);
    END LOOP;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_link_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_LINK';

CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_report_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_REPORT';

DO $$
DECLARE
  part regclass;
  idx text;
BEGIN
  FOREACH idx IN ARRAY ARRAY['audit_events_resource_payment_link_idx',
                             'audit_events_resource_payment_report_idx']
  LOOP
    FOR part IN SELECT inhrelid::regclass FROM pg_inherits
                 WHERE inhparent = 'public.audit_events'::regclass LOOP
      EXECUTE format('ALTER INDEX %I ATTACH PARTITION %I', idx,
        replace(idx, 'audit_events', part::text));
    END LOOP;
  END LOOP;
END $$;
