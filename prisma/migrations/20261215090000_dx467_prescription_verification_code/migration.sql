-- DX-467: receta verificable. Cada receta lleva un CÓDIGO corto que la
-- impresión muestra (y su QR, que apunta a `/receta/<código>` en el host de la
-- clínica) y que cualquiera puede comprobar en la página pública: válida,
-- anulada o «no se puede verificar».
--
--   prescriptions."verificationCode"  TEXT, 12 caracteres de
--   «23456789ABCDEFGHJKMNPQRSTUVWXYZ» (31 símbolos: sin 0/O, 1/I/L), ~59 bits.
--
-- Aleatorio (CSPRNG), NUNCA derivado del id: no se puede adivinar ni calcular
-- el de otra receta. La app lo genera al emitir
-- (`prescription-verification-code.ts`, crypto.randomInt); el DEFAULT de la
-- columna es la red para una réplica anterior que emita durante el
-- despliegue (inserta sin nombrar la columna) y es lo que usa el relleno.
-- Sin pgcrypto: los bytes salen de `gen_random_uuid()` (pg_strong_random), el
-- primer byte de un UUID v4 es aleatorio entero; se descartan los >= 248
-- (8 × 31) para que ningún símbolo salga más que otro.
--
-- FUERA del hash de la receta (como el logo congelado, DX-019-bis): meterlo
-- invalidaría todos los hashes v1–v4 guardados. Nace inmutable igualmente:
-- `prescriptions_immutable` compara la fila entera salvo las columnas de
-- anulación.
--
-- Expand: columna NULL sin default (solo catálogo) y luego SET DEFAULT (solo
-- afecta a las filas nuevas, sin reescribir la tabla). El CHECK (forma y NOT
-- NULL) va NOT VALID aquí; el relleno es
-- 20261215090100_dx467_prescription_verification_code_backfill y el VALIDATE,
-- el SET NOT NULL y el índice único van en
-- 20261215090200_dx467_prescription_verification_code_validate. Sin fechas:
-- sin trigger UTC. La columna hereda el grant de la tabla y su RLS.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."dx_prescription_verification_code"() RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text := '';
  b integer;
BEGIN
  WHILE pg_catalog.length(code) < 12 LOOP
    b := pg_catalog.get_byte(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 0);
    IF b < 248 THEN
      code := code || pg_catalog.substr(alphabet, (b % 31) + 1, 1);
    END IF;
  END LOOP;
  RETURN code;
END;
$$;

ALTER TABLE "prescriptions"
  ADD COLUMN "verificationCode" TEXT;

ALTER TABLE "prescriptions"
  ALTER COLUMN "verificationCode" SET DEFAULT public."dx_prescription_verification_code"();

-- IS NOT NULL dentro del CHECK: validado, deja que el SET NOT NULL posterior
-- no recorra la tabla bajo ACCESS EXCLUSIVE.
ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_verification_code_check" CHECK (
    "verificationCode" IS NOT NULL
    AND "verificationCode" ~ '^[2-9A-HJKMNP-Z]{12}$'
  ) NOT VALID;
