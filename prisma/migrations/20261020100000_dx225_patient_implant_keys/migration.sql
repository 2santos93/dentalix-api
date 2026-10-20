-- DX-225 (DB-035): la búsqueda por lote / referencia de implantes usa su
-- índice también bajo RLS.
--
-- Por qué: bajo RLS FORCE Postgres solo usa como condición de índice las
-- cláusulas cuyas funciones son LEAKPROOF. `upper` y `btrim` no lo son, así
-- que `upper(btrim("lot")) = upper($1)` quedaba en Filter y de los índices de
-- expresión de DX-191 solo se aprovechaba el prefijo "tenantId" (Seq Scan de
-- todos los implantes de la clínica). Una columna comparada con `=`
-- (`texteq`, LEAKPROOF) sí es condición de índice.
--
-- Cambios:
--   patient_implants   "lotKey" / "referenceKey": columnas GENERADAS
--                      almacenadas, upper(btrim(...)) de "lot" / "reference".
--                      Nadie las escribe (Postgres rechaza un valor explícito).
--   índices            ("tenantId", "lotKey") y ("tenantId", "referenceKey");
--                      se retiran los de expresión de DX-191, que ya no sirve
--                      ninguna consulta.
--   dx_patient_implants_immutable   ignora las dos claves al comparar OLD y
--                      NEW: en un trigger BEFORE las columnas generadas aún
--                      no están calculadas (NEW las trae a NULL) y, sin
--                      excluirlas, anular un implante o marcar su tarjeta
--                      fallaría. Siguen inalterables porque derivan de "lot"
--                      y "reference", que el trigger sí compara.
--
-- Bloqueo: ADD COLUMN ... STORED reescribe patient_implants (ACCESS EXCLUSIVE
-- hasta el COMMIT). Es una tabla nueva (DX-191) y pequeña: la reescritura y
-- los dos CREATE INDEX no concurrentes duran milisegundos. lock_timeout evita
-- quedar encolado detrás de una transacción larga.
--
-- Compatible hacia atrás: el código anterior no lee ni escribe las columnas
-- nuevas y su consulta (upper(btrim(...))) sigue dando el mismo resultado,
-- solo sin índice.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_implants"
  ADD COLUMN "lotKey" TEXT GENERATED ALWAYS AS (upper(btrim("lot"))) STORED,
  ADD COLUMN "referenceKey" TEXT GENERATED ALWAYS AS (upper(btrim("reference"))) STORED;

CREATE INDEX "patient_implants_tenant_lot_key_idx"
  ON "patient_implants"("tenantId", "lotKey");
CREATE INDEX "patient_implants_tenant_reference_key_idx"
  ON "patient_implants"("tenantId", "referenceKey");

DROP INDEX "patient_implants_tenant_lot_idx";
DROP INDEX "patient_implants_tenant_reference_idx";

-- Versión vigente (20261017235200_dx191_patient_implants) más las claves
-- generadas en la lista de columnas que no se comparan.
CREATE OR REPLACE FUNCTION public."dx_patient_implants_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  void_columns CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
  card_columns CONSTANT text[] := ARRAY['cardDeliveredAt', 'cardDeliveredById'];
  -- Generadas: NULL en NEW dentro de un trigger BEFORE (DX-225).
  generated_columns CONSTANT text[] := ARRAY['lotKey', 'referenceKey'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_implants es inalterable: no se permite % de un implante registrado; para corregirlo se anula con motivo (DX-191)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns - card_columns - generated_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns - card_columns - generated_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
     OR (OLD."cardDeliveredAt" IS NOT NULL AND (
           NEW."cardDeliveredAt" IS DISTINCT FROM OLD."cardDeliveredAt"
           OR NEW."cardDeliveredById" IS DISTINCT FROM OLD."cardDeliveredById"))
  THEN
    RAISE EXCEPTION 'patient_implants es inalterable: un implante registrado solo se anula (una vez) o se marca su tarjeta como entregada (DX-191)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
