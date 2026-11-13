-- DX-274-bis: dos categorías predefinidas de gastos cambian a términos
-- neutros (el producto es mundial; nada de regionalismos):
--   «Arriendo»          -> «Alquiler»
--   «Aseo y cafetería»  -> «Limpieza y cafetería»
-- Las predefinidas son constantes de código (src/modules/expenses/domain/
-- expense-categories.ts); el gasto guarda una FOTO del nombre en
-- expenses."category". Las salidas de caja menor son pagos de gasto
-- (expense_payments con "cashSessionId") y leen la categoría de su gasto: con
-- reescribir la foto del gasto basta.
--
-- Qué hace, clínica a clínica:
--   1. Retira (como DELETE /expense-categories/:id: "active" = false y
--      "deletedAt") la categoría PROPIA viva cuyo nombre, sin mayúsculas ni
--      tildes, es ya una predefinida nueva («Alquiler», «Limpieza y
--      cafetería»). Es la misma categoría con el mismo nombre: se funde con la
--      predefinida en vez de salir dos veces en el selector. Sus gastos
--      conservan la foto (ya es el nombre nuevo; el paso 2 solo iguala la
--      grafía). La demo creaba «Alquiler» como propia (DX-335). Retirar
--      libera el único parcial expense_categories_tenant_name_norm_key
--      (solo cuenta las vivas), así que no puede violarlo.
--   2. Reescribe la foto de los gastos (anulados incluidos) cuyo nombre
--      normalizado es el viejo o el nuevo de esas dos predefinidas a la grafía
--      nueva exacta. EXCEPTO si la clínica tiene una categoría PROPIA viva con
--      ese mismo nombre normalizado: entonces el nombre es suyo y sus gastos
--      no se tocan. Una propia «Arriendo» no se puede crear por la API (desde
--      DX-274 da 409 por coincidir con una predefinida), así que en la práctica
--      solo existe si alguien la insertó por SQL; si existe, sus gastos y los
--      que se hubieran puesto con la predefinida no se distinguen (la foto es
--      el mismo texto), y se prefiere no tocar ninguno antes que renombrar uno
--      que la clínica eligió.
--
-- Triggers: expenses_guard (dx_expense_guard, DX-274/DX-393) solo protege la
-- identidad, el soporte, la anulación y el importe; "category" se puede
-- editar (PATCH /expenses/:id), también en un gasto anulado. No hace falta
-- desactivar ningún trigger. expense_categories solo tiene el de alta. Sin
-- auditoría: es una corrección de datos, no una edición de la clínica; los
-- eventos de auditoría anteriores conservan el texto de su momento.
-- "updatedAt" del gasto no se toca por el mismo motivo.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada una
-- (molde de DX-019-bis y DX-467). La clínica se limpia al final.
--
-- Idempotente: una segunda pasada no encuentra propias vivas que retirar ni
-- fotos distintas de la grafía nueva. Las réplicas anteriores que escriban el
-- nombre viejo durante el despliegue las corrige el trigger de la migración
-- siguiente (20261219090100_dx274b_expense_category_legacy_alias).
--
-- Compatible hacia atrás: no cambia el esquema. La API anterior sigue
-- leyendo y filtrando los gastos (la foto es texto libre).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);

    UPDATE public."expense_categories" c
       SET "active" = false,
           "deletedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
           "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
     WHERE c."tenantId" = t
       AND c."deletedAt" IS NULL
       AND public.dx_search_normalize(c."name") IN ('alquiler', 'limpieza y cafeteria');

    UPDATE public."expenses" e
       SET "category" = m."name"
      FROM (VALUES ('arriendo', 'Alquiler'),
                   ('alquiler', 'Alquiler'),
                   ('aseo y cafeteria', 'Limpieza y cafetería'),
                   ('limpieza y cafeteria', 'Limpieza y cafetería')
           ) AS m("key", "name")
     WHERE e."tenantId" = t
       AND public.dx_search_normalize(e."category") = m."key"
       AND e."category" IS DISTINCT FROM m."name"
       AND NOT EXISTS (
         SELECT 1 FROM public."expense_categories" c
          WHERE c."tenantId" = t
            AND c."deletedAt" IS NULL
            AND public.dx_search_normalize(c."name") = m."key"
       );
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);
END
$$;
COMMIT;
