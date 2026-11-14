-- DX-274-bis: red en la BD para el despliegue. Mientras convivan réplicas de
-- la API anterior (que aún ofrecen «Arriendo» y «Aseo y cafetería» como
-- predefinidas) con esta migración ya aplicada, un gasto nuevo o editado
-- podría guardar la foto con el nombre viejo después del relleno de
-- 20261219090000_dx274b_expense_category_neutral_names. Este trigger hace en
-- cada alta o cambio de "category" lo mismo que ese relleno: el nombre viejo
-- (o el nuevo con otra grafía) pasa a la grafía nueva exacta, salvo que la
-- clínica tenga una categoría PROPIA viva con ese nombre normalizado (es
-- suya; misma regla que el relleno). La API nueva ya manda la grafía nueva:
-- para ella el trigger no cambia nada. Se queda después del despliegue: un
-- cliente o una importación antiguos tampoco pueden reintroducir el nombre.
--
-- Cambios:
--   dx_expense_category_legacy_alias()   función del trigger (SECURITY
--                       INVOKER: la consulta de propias va bajo la RLS de
--                       quien escribe, cuya clínica es la del gasto).
--   expenses_category_legacy_alias       BEFORE INSERT OR UPDATE OF
--                       "category" ON expenses, por fila.
--
-- Solo mira la tabla de categorías cuando el nombre normalizado es uno de los
-- cuatro; el resto de escrituras paga una normalización del texto.
--
-- Compatible hacia atrás: la API anterior no lee el nombre que escribe, solo
-- lo devuelve; tras el trigger devuelve la grafía nueva, que es una categoría
-- válida para cualquier versión (la anterior la trata como texto libre en las
-- fotos y la acepta como propia si la clínica la tenía).
--
-- Grants: sin tablas nuevas; EXECUTE de la función es de PUBLIC por defecto.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx_expense_category_legacy_alias() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k text := public.dx_search_normalize(NEW."category");
  renamed text;
BEGIN
  renamed := CASE k
    WHEN 'arriendo' THEN 'Alquiler'
    WHEN 'alquiler' THEN 'Alquiler'
    WHEN 'aseo y cafeteria' THEN 'Limpieza y cafetería'
    WHEN 'limpieza y cafeteria' THEN 'Limpieza y cafetería'
  END;
  IF renamed IS NULL OR NEW."category" = renamed THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."expense_categories" c
     WHERE c."tenantId" = NEW."tenantId"
       AND c."deletedAt" IS NULL
       AND public.dx_search_normalize(c."name") = k
  ) THEN
    RETURN NEW;
  END IF;
  NEW."category" := renamed;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_category_legacy_alias" ON "expenses";
CREATE TRIGGER "expenses_category_legacy_alias"
  BEFORE INSERT OR UPDATE OF "category" ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_category_legacy_alias();
COMMIT;
