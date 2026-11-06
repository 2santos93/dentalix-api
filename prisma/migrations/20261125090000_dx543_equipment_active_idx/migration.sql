-- DX-543: avisos de mantenimiento en «Mi día». La consulta de los avisos
-- (`maintenanceCandidatesSql`) lee los equipos ACTIVOS de la clínica, de una
-- sede o de todas. Parcial: los dados de baja (que se acumulan con los años y
-- nunca avisan) no entran, así que el índice es pequeño.
--
-- No es concurrente: la tabla es nueva (DX-542) y pequeña; el CREATE INDEX la
-- bloquea para escritura solo lo que tarda en construirse.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261125090000_dx543_equipment_active_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva: nada se borra ni cambia. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX "equipment_tenant_active_location_idx".

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "equipment_tenant_active_location_idx"
  ON "equipment"("tenantId", "locationId")
  WHERE "status" = 'ACTIVE';
