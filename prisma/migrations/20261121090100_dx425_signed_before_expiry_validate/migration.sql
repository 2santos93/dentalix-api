-- DX-425 (DB-062): valida el CHECK `signature_requests_signed_before_expiry_check`
-- que la migración anterior dejó NOT VALID. VALIDATE CONSTRAINT toma SHARE
-- UPDATE EXCLUSIVE: recorre la tabla sin bloquear lecturas ni escrituras (por
-- eso va en su propia migración y no con el ADD CONSTRAINT, cuyo ACCESS
-- EXCLUSIVE duraría hasta el COMMIT). La validación no pasa por la RLS, así que
-- sirve con el owner de producción (sin superusuario ni BYPASSRLS).
--
-- Si hubiera una solicitud firmada después de su caducidad (la API no lo
-- permite: `isLinkUsable` lo rechaza), VALIDATE se DETIENE con el error de la
-- restricción en vez de tocar la evidencia de una firma: revisa esas filas a
-- mano (SELECT "id", "signedAt", "expiresAt" FROM signature_requests
-- WHERE "signedAt" > "expiresAt"; no se reescriben `signedAt` ni `expiresAt`) y
-- reaplica.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_signed_before_expiry_check";
