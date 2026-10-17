-- DX-216: serie de recibos de la sede ("receiptPrefix", DX-136) segura ante
-- altas concurrentes de sedes de la misma clínica.
--
-- El trigger BEFORE INSERT de DX-136 elige la serie mirando las que ya usa la
-- clínica. Dos altas a la vez (onboarding, importación, un test con
-- Promise.all) no se ven entre sí hasta confirmar: las dos eligen la misma
-- serie y la segunda falla con «Unique constraint failed on (tenantId,
-- receiptPrefix)».
--
-- Arreglo: el trigger toma un candado consultivo de transacción POR CLÍNICA
-- (pg_advisory_xact_lock con la clave doble ('dx_location_receipt_prefix',
-- tenantId)) antes de elegir la serie. La segunda alta espera a que la
-- primera confirme o deshaga y, al seguir, su consulta (snapshot nuevo en READ
-- COMMITTED, el nivel con el que la API crea sedes) ya ve la serie tomada y
-- elige la siguiente. El candado se suelta solo al acabar la transacción. Se
-- toma en TODA alta de sede, también con la serie explícita: así una alta
-- derivada nunca elige una serie que otra transacción tiene sin confirmar.
-- Solo ordena las altas de sedes de UNA clínica: otras clínicas usan otra
-- clave y no esperan. Respeta el lock_timeout / statement_timeout de quien
-- inserta.
--
-- Compatible hacia atrás y sin backfill: solo se reemplaza el cuerpo de la
-- función del trigger (mismo nombre, firma, dueño y trigger). Ninguna fila
-- cambia; las series existentes quedan intactas. No toca la RLS ni el FORCE de
-- `locations`, ni privilegios.
--
-- search_path fijo con pg_temp al final y funciones de catálogo calificadas
-- (SEC-032 / SEC-035): es una función de trigger.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx_location_default_receipt_prefix() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Una alta de sede de la clínica a la vez hasta el final de la transacción.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('dx_location_receipt_prefix'),
    pg_catalog.hashtext(NEW."tenantId"::text)
  );
  IF NEW."receiptPrefix" IS NULL THEN
    NEW."receiptPrefix" := public.dx_location_receipt_prefix(NEW."tenantId", NEW."name", NEW."id");
  END IF;
  RETURN NEW;
END;
$$;
