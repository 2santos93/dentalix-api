-- DX-418: el acumulado de anestesia local es del PACIENTE en una ventana
-- móvil de 24 h (todas sus evoluciones y sedes de la clínica), no de la
-- evolución. La consulta filtra por (tenant, paciente, "administeredAt") y
-- ordena por "administeredAt": el índice de DX-307 empieza por la evolución y
-- no sirve para el rango.
--
-- Aditiva, sin cambios de datos. No es CONCURRENTLY (Prisma envuelve la
-- migración en una transacción); la tabla es pequeña (append-only, una fila
-- por carpule registrado) y el bloqueo de escrituras dura lo que tarda en
-- construirse. lock_timeout 5 s acota la ESPERA; si falla: `npx prisma
-- migrate resolve --rolled-back 20261106110000_dx418_anesthesia_patient_window_idx`
-- y repetir `migrate deploy`. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "anesthesia_administrations_patient_time_idx"
  ON "anesthesia_administrations"("tenantId", "patientId", "administeredAt");
