-- DX-588: índice parcial de audit_events para WAITING_ROOM_SCREEN.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en
-- 20270130090000_dx588_audit_enum. Plantilla ON ONLY + ATTACH de DX-556
-- (DX-148): primero el índice de cada partición (la del mes en curso y la
-- DEFAULT al final), luego el del padre ON ONLY y el ATTACH de cada una.
--
-- lock_timeout 5 s. Si falla: `npx prisma migrate resolve --rolled-back
-- 20270130090100_dx588_audit_events_idx` y repetir `migrate deploy`.
--
-- Aditiva. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX "audit_events_resource_waiting_room_screen_idx".

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  part regclass;
BEGIN
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
      replace('audit_events_resource_waiting_room_screen_idx', 'audit_events', part::text),
      part, 'WAITING_ROOM_SCREEN');
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "audit_events_resource_waiting_room_screen_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'WAITING_ROOM_SCREEN';

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits
               WHERE inhparent = 'public.audit_events'::regclass LOOP
    EXECUTE format('ALTER INDEX %I ATTACH PARTITION %I',
      'audit_events_resource_waiting_room_screen_idx',
      replace('audit_events_resource_waiting_room_screen_idx', 'audit_events', part::text));
  END LOOP;
END $$;
