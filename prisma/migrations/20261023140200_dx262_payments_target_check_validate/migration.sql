-- DX-262: valida payments_target_check (20261023140000). VALIDATE de un
-- CHECK toma SHARE UPDATE EXCLUSIVE: recorre payments sin bloquear lecturas
-- ni escrituras (sola, sin otro ALTER que suba el bloqueo). Todas las filas
-- anteriores tienen plan y ninguna saldo migrado, así que cumplen. No usa la
-- RLS (un CHECK ve todas las filas): no hace falta NO FORCE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_target_check";
