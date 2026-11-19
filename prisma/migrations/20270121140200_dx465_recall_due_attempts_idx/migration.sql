-- DX-465: el índice de la lista de recall con el estado del ciclo en el
-- INCLUDE, para que `c` de recallDueSql siga siendo un rango SOLO de índice
-- (los filtros de oculto y agotados se evalúan en `d` con esas columnas, sin
-- volver a la tabla por candidato). Mismo predicado y clave que
-- patient_recalls_tenant_due_visit_idx (20261212090600), que se suelta en
-- 20270121140300. CONCURRENTLY y solo en su fichero (lint de DX-148).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patient_recalls_tenant_due_attempts_idx" ON "patient_recalls" ("tenantId", "dueAt") INCLUDE ("id", "patientId", "recallTypeId", "kind", "intervalMonths", "lastDoneAt", "disabledUntil", "locationId", "visitLocationId", "attemptCount", "lastAttemptAt", "callbackOn", "skipUntil", "cycleDueAt") WHERE "active";
