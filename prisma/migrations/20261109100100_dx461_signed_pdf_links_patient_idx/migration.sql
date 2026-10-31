-- DX-461: archivar a un paciente anula sus enlaces públicos vivos en la misma
-- transacción (y el diálogo de archivar los cuenta antes). Los demás filtros
-- por paciente ya tienen índice que empieza por ("tenantId", "patientId")
-- (waitlist_offers_tenant_patient_day_idx, signature_requests_patient_idx,
-- medical_history_submissions_patient_idx); el de la copia del PDF firmado
-- empieza por "consentId", así que buscar por paciente recorrería la tabla.
--
-- Índice PARCIAL sobre los enlaces vivos (sin usar ni invalidar): los que
-- anular o contar. Aditivo y compatible hacia atrás: el código anterior no lo
-- usa ni lo necesita. Tabla pequeña (un enlace por envío de la copia): el
-- bloqueo de escritura dura poco; lock_timeout acota la espera. Si falla:
-- `npx prisma migrate resolve --rolled-back 20261109100000_dx461_signed_pdf_links_patient_idx`
-- y repetir `migrate deploy`. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "signed_consent_pdf_links_patient_live_idx"
  ON "signed_consent_pdf_links"("tenantId", "patientId")
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;
