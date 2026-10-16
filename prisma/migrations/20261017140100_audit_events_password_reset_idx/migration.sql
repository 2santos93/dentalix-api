-- DX-010: índice parcial del valor de auditoría PASSWORD_RESET.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_action_<valor>_idx" por cada valor de "AuditAction" salvo
-- VIEW (la igualdad de enums no sirve de condición de índice bajo RLS; el
-- predicado parcial sí). Va en su PROPIA migración: el valor se añadió en
-- 20261017140000_user_tokens y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- Aditiva. Funciona con la tabla de DX-009 y con la particionada de DX-102
-- (en ese caso se propaga a cada partición). IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_action_password_reset_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "action" = 'PASSWORD_RESET';
