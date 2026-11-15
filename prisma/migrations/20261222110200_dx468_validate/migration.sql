-- DX-468: VALIDATE de lo que 20261222110100 dejó NOT VALID: el CHECK de actor
-- de audit_events (la apertura pública de la copia de la receta) y el del pie
-- de la copia en tenants. Va en su propia transacción: SHARE UPDATE EXCLUSIVE
-- lee la tabla sin bloquear la escritura (molde de DX-361 / DX-443 / DX-467).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_prescription_patient_copy_footer_check";
