-- DX-425 (DB-062): valida el CHECK `signature_requests_signed_before_expiry_check`
-- que la migración anterior dejó NOT VALID. VALIDATE CONSTRAINT toma SHARE
-- UPDATE EXCLUSIVE: recorre la tabla sin bloquear lecturas ni escrituras (por
-- eso va en su propia migración y no con el ADD CONSTRAINT, cuyo ACCESS
-- EXCLUSIVE duraría hasta el COMMIT).
--
-- Si hubiera una solicitud firmada después de su caducidad (la API no lo
-- permite: `isLinkUsable` lo rechaza), la migración se DETIENE con un mensaje
-- claro en vez de tocar la evidencia de una firma: hay que revisar esas filas a
-- mano (no se reescriben `signedAt` ni `expiresAt`) y reaplicar.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM "signature_requests"
   WHERE "signedAt" IS NOT NULL AND "signedAt" > "expiresAt";
  IF bad > 0 THEN
    RAISE EXCEPTION 'DX-425: % solicitud(es) de firma tienen signedAt posterior a expiresAt; revísalas antes de validar signature_requests_signed_before_expiry_check (SELECT "id", "signedAt", "expiresAt" FROM signature_requests WHERE "signedAt" > "expiresAt")', bad;
  END IF;
END
$$;

ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_signed_before_expiry_check";
