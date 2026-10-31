-- DX-438 (DB-066): el saldo a favor (DX-253) se guarda en asientos de
-- `patient_credit_entries` en la moneda del plan, y todas las lecturas
-- (`planCredit` del repositorio, la guarda de anulación de abonos,
-- `patient_ledgers_compute` y el estado de cuenta) suman solo los asientos
-- cuya moneda es la ACTUAL del plan. Un plan en borrador o presentado que
-- recibió un traspaso no tiene abonos, así que podía cambiar de moneda: su
-- TRANSFER_IN se quedaba en la moneda vieja y el saldo desaparecía de todos
-- los saldos visibles, sin error.
--
-- Trigger `treatment_plans_credit_currency_locked` (BEFORE UPDATE OF currency,
-- solo si la moneda cambia de verdad): rechaza el cambio con
-- restrict_violation (23001, que la API traduce a 409) si el plan tiene algún
-- asiento de saldo a favor (traspaso dado o recibido, o devolución). La app
-- responde 409 antes, con su propio código (PLAN_CURRENCY_LOCKED_BY_CREDIT);
-- esto es la red. Otras columnas, y repetir la misma moneda, no se miran.
--
-- SECURITY INVOKER: la búsqueda va bajo la RLS de la sesión y filtra por el
-- `tenantId` de la fila. dentalix_app siempre trabaja con su clínica fijada y
-- ve sus asientos; un superusuario (o un rol BYPASSRLS) también. Un owner sin
-- superusuario sin `app.current_tenant` no ve los asientos (FORCE) y el
-- trigger no lo detiene: el mantenimiento a mano fija la clínica antes.
-- La búsqueda usa el índice `patient_credit_entries_tenant_plan_idx`
-- ("tenantId", "treatmentPlanId", …) de DX-253: sin índices nuevos.
--
-- Compatible hacia atrás: solo catálogo (función + trigger), sin columnas ni
-- reescritura de filas; el código anterior solo lo nota si intenta lo que esta
-- tarea prohíbe. Los asientos que ya estuvieran en otra moneda que su plan
-- (debería no haber ninguno) se listan, sin tocarlos, con
-- `prisma/scripts/credit-currency-report.sql`.
--
-- Bloqueo: CREATE TRIGGER toma SHARE ROW EXCLUSIVE sobre treatment_plans
-- milisegundos (no recorre filas). lock_timeout evita quedar encolado tras una
-- transacción larga.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public."treatment_plans_credit_currency_locked"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."patient_credit_entries" e
     WHERE e."tenantId" = OLD."tenantId"
       AND e."treatmentPlanId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'el plan tiene saldo a favor traspasado o devuelto en su moneda: la moneda del plan ya no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plans_credit_currency_locked"
  BEFORE UPDATE OF "currency" ON "treatment_plans"
  FOR EACH ROW
  WHEN (NEW."currency" IS DISTINCT FROM OLD."currency")
  EXECUTE FUNCTION public."treatment_plans_credit_currency_locked"();
