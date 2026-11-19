-- DX-465: el índice anterior de la lista (20261212090600), ya cubierto por
-- patient_recalls_tenant_due_attempts_idx (20270122140200). CONCURRENTLY y
-- solo en su fichero (lint de DX-148).
DROP INDEX CONCURRENTLY IF EXISTS "patient_recalls_tenant_due_visit_idx";
