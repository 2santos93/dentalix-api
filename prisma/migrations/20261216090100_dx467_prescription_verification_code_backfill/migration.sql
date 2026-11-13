-- DX-467: relleno ÚNICO del código de verificación de las recetas ya
-- emitidas, con la misma función que el DEFAULT
-- (20261216090000_dx467_prescription_verification_code). Una colisión con otro
-- código es improbable (31^12) pero no imposible: el índice único llega en la
-- migración siguiente, así que aquí se comprueba a mano y se repite el sorteo
-- de esa fila; la siguiente migración falla de forma ruidosa si aun así
-- quedara un duplicado.
--
-- `prescriptions` es inmutable por trigger. Se desactiva SOLO
-- `prescriptions_immutable`, SOLO alrededor del UPDATE y en la MISMA
-- transacción: un fallo revierte relleno y desactivación juntos, y nadie más
-- ve nunca el trigger desactivado (DISABLE TRIGGER toma SHARE ROW EXCLUSIVE:
-- deja leer y hace esperar a las escrituras hasta el COMMIT). Precedente:
-- 20261203090100_dx019b_clinic_logo_key_backfill. El UPDATE solo escribe
-- "verificationCode" (test/prescription-verification-code.int-spec.ts compara
-- el resto de la fila y el estado del trigger al terminar).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada una
-- (molde de DX-019-bis). La clínica se limpia al final.
--
-- Idempotente (solo filas con el código NULL). Una réplica anterior que emita
-- tras este relleno recibe el DEFAULT: no deja NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions" DISABLE TRIGGER "prescriptions_immutable";
DO $$
DECLARE
  t uuid;
  rx uuid;
  candidate text;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    FOR rx IN
      SELECT p."id" FROM public."prescriptions" p
       WHERE p."tenantId" = t AND p."verificationCode" IS NULL
       ORDER BY p."id"
    LOOP
      LOOP
        candidate := public."dx_prescription_verification_code"();
        -- Bajo la RLS de esta clínica: un duplicado de OTRA clínica no se ve
        -- aquí; lo para el índice único de la migración siguiente.
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM public."prescriptions" o
           WHERE o."verificationCode" = candidate
        );
      END LOOP;
      UPDATE public."prescriptions"
         SET "verificationCode" = candidate
       WHERE "tenantId" = t AND "id" = rx;
    END LOOP;
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);
END
$$;
ALTER TABLE "prescriptions" ENABLE TRIGGER "prescriptions_immutable";
COMMIT;
