-- DX-319: se borra el código REPS de la sede (paso 2 de 2). El código ya no
-- lee ni escribe locations."repsHabilitationCode" (DX-311: Dentalix es global
-- y el REPS solo servía en Colombia).
--
-- 1. El REPS existente se COPIA a "healthRegistrationNumber" antes del DROP:
--    en Colombia es el registro sanitario de la sede, y así el ADMIN no lo
--    pierde. Solo en sedes sin nº propio (no pisa nada) y sin imprimirlo
--    ("showHealthRegistrationNumber" sigue en false: hoy ningún documento lo
--    imprimía). El REPS son 12 dígitos (CHECK
--    locations_reps_habilitation_code_format), así que cumple el CHECK nuevo.
-- 2. DROP COLUMN IF EXISTS. Lo único que referencia la columna es su CHECK
--    (20261019100100_dx212_rda_codes): ni vistas, ni funciones, ni triggers,
--    ni índices, ni políticas RLS. El CHECK se borra explícitamente (y con la
--    columna lo haría Postgres igual).
--
-- No falla con datos: los valores que no se copian (sede con nº propio) se
-- descartan. Idempotente: sin la columna, la copia no hace nada.
--
-- row_security = off y NO FORCE durante la copia: con RLS FORCE el owner sin
-- BYPASSRLS vería 0 sedes y la copia no haría nada en silencio (DX-113, como
-- 20261020210200_dx153_insurer_eps_backfill). Se restaura en la misma
-- transacción. El UPDATE no toca "receiptPrefix": no dispara
-- locations_receipt_prefix_guard.
--
-- Despliegue: el código de esta rama ya no selecciona la columna; una
-- instancia del código anterior que siga viva tras la migración fallaría al
-- leer sedes, así que la migración va con el despliegue del código nuevo.
--
-- Grants: no aplica.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'locations'
       AND column_name = 'repsHabilitationCode'
  ) THEN
    EXECUTE $copy$
      UPDATE "locations"
         SET "healthRegistrationNumber" = btrim("repsHabilitationCode")
       WHERE "healthRegistrationNumber" IS NULL
         AND NULLIF(btrim("repsHabilitationCode"), '') IS NOT NULL
    $copy$;
  END IF;
END
$$;

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "locations_reps_habilitation_code_format";
ALTER TABLE "locations" DROP COLUMN IF EXISTS "repsHabilitationCode";
