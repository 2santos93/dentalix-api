-- DX-497: VALIDATE de los CHECK de formato de idioma que 20261217090000 creó
-- NOT VALID. En su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla
-- sin bloquear sus escrituras (molde de DX-361 / DX-467). Las columnas son
-- nuevas (todo NULL), así que no puede fallar.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_preferred_language_check";
ALTER TABLE "outbound_messages" VALIDATE CONSTRAINT "outbound_messages_language_check";
