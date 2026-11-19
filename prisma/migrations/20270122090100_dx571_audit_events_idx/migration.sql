-- DX-571: índices parciales de audit_events para BANK_ACCOUNT,
-- BANK_STATEMENT_IMPORT y BANK_RECONCILIATION_MATCH.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20270122090000_dx571_audit_enum. Plantilla ON ONLY + ATTACH de DX-556
-- (DX-148): primero el índice de cada partición (la del mes en curso y la
-- DEFAULT al final), luego el del padre ON ONLY y el ATTACH de cada una.
--
-- lock_timeout 5 s. Si falla: `npx prisma migrate resolve --rolled-back
-- 20270122090100_dx571_audit_events_idx` y repetir `migrate deploy`.
--
-- Aditiva. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX de los tres "audit_events_resource_bank_*_idx".

SET LOCAL lock_timeout = '5s';

-- BANK_ACCOUNT
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
      replace('audit_events_resource_bank_account_idx', 'audit_events', part::text),
      part, 'BANK_ACCOUNT');
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "audit_events_resource_bank_account_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'BANK_ACCOUNT';

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits
               WHERE inhparent = 'public.audit_events'::regclass LOOP
    EXECUTE format('ALTER INDEX %I ATTACH PARTITION %I',
      'audit_events_resource_bank_account_idx',
      replace('audit_events_resource_bank_account_idx', 'audit_events', part::text));
  END LOOP;
END $$;

-- BANK_STATEMENT_IMPORT
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
      replace('audit_events_resource_bank_statement_import_idx', 'audit_events', part::text),
      part, 'BANK_STATEMENT_IMPORT');
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "audit_events_resource_bank_statement_import_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'BANK_STATEMENT_IMPORT';

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits
               WHERE inhparent = 'public.audit_events'::regclass LOOP
    EXECUTE format('ALTER INDEX %I ATTACH PARTITION %I',
      'audit_events_resource_bank_statement_import_idx',
      replace('audit_events_resource_bank_statement_import_idx', 'audit_events', part::text));
  END LOOP;
END $$;

-- BANK_RECONCILIATION_MATCH
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
      replace('audit_events_resource_bank_reconciliation_match_idx', 'audit_events', part::text),
      part, 'BANK_RECONCILIATION_MATCH');
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "audit_events_resource_bank_reconciliation_match_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'BANK_RECONCILIATION_MATCH';

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits
               WHERE inhparent = 'public.audit_events'::regclass LOOP
    EXECUTE format('ALTER INDEX %I ATTACH PARTITION %I',
      'audit_events_resource_bank_reconciliation_match_idx',
      replace('audit_events_resource_bank_reconciliation_match_idx', 'audit_events', part::text));
  END LOOP;
END $$;
