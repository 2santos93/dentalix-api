-- SEC-050: el cargo por inasistencia o cancelación tardía (DX-291) solo se
-- anula por su propia acción (`POST /appointments/:id/cancellation-fee/void`,
-- ADMIN o RECEPTION con permiso de la política, con motivo y auditada). Antes
-- cualquier rol clínico lo rebajaba (PATCH del precio del ítem) o lo anulaba
-- («Quitar» el ítem) desde el plan, sin motivo.
--
-- 1. `cancellation_fees`: tres columnas de la anulación (cuándo, quién y el
--    motivo de 3 a 500), todas a la vez y solo en un CHARGED (CHECK). Sigue
--    siendo la prueba de lo decidido: la app solo puede ESCRIBIR esas tres
--    columnas (GRANT por columna; el resto sigue sin UPDATE) y una sola vez,
--    sin tocar nada más de la fila, y no borra filas (trigger
--    `cancellation_fees_append_only`). DB-052: hasta ahora la tabla solo se
--    protegía con REVOKE; si se vuelve a ejecutar el `GRANT … ON ALL TABLES`
--    de `docker/prod/create-app-role.sql`, el trigger sigue impidiendo
--    reescribir o borrar el cargo. Las únicas escrituras legítimas de hoy son
--    el INSERT del cargo (CHARGED) o de la condonación (WAIVED), que el
--    trigger no mira, y la anulación (SEC-050).
-- 2. `treatment_plan_items`: mientras el cargo esté vigente (CHARGED y sin
--    anular), su ítem no cambia de precio, descuento (ni su motivo), estado,
--    plan, procedimiento o paciente, ni se retira ni se borra (trigger
--    `treatment_plan_items_cancellation_fee_locked`).
-- 3. `treatment_plans`: el plan que lleva un cargo vigente no se cancela,
--    rechaza ni vuelve atrás (solo puede completarse), ni cambia de moneda o
--    paciente, ni se retira (trigger `treatment_plans_cancellation_fee_locked`):
--    un plan cancelado o rechazado no se cobra (DX-109) y sería otra forma de
--    condonar el cargo.
--
-- Cómo pasa la anulación legítima: el caso de uso, en UNA transacción, con la
-- cita y la fila del cargo bloqueadas, primero marca el cargo como anulado
-- (voidedAt, voidedById, voidReason) y después retira el ítem. El trigger del
-- ítem lee la fila del cargo en esa misma transacción: ya no está vigente y
-- deja pasar el retiro. No hay variable de sesión que alguien pueda fijar
-- para saltárselo: para tocar el ítem hay que dejar antes la anulación, con
-- su autor y su motivo, en `cancellation_fees`.
--
-- Los dos triggers de planes siguen la red de DX-109
-- (`treatment_plan_items_locked_when_closed`): la app responde 409 antes;
-- esto es la red (restrict_violation, que la API traduce a 409). Sin
-- `app.current_tenant` (mantenimiento con el rol propietario) no aplican. El
-- de `cancellation_fees` aplica siempre (salvo el DELETE de un superusuario).
--
-- Compatible hacia atrás: columnas NULLABLE sin DEFAULT (solo catálogo, no
-- reescribe la tabla), un CHECK que valida con todas a NULL y triggers que el
-- código anterior solo nota si intenta lo que este ticket prohíbe. Sin pérdida
-- de datos. Los índices de las columnas nuevas van aparte, CONCURRENTLY.
--
-- FK bajo FORCE (DX-134): NO FORCE en `cancellation_fees` en esta misma
-- transacción y FORCE de vuelta al final (`users` no tiene FORCE).

SET LOCAL lock_timeout = '10s';

ALTER TABLE "cancellation_fees" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. Anulación del cargo.
-- ---------------------------------------------------------------------------
ALTER TABLE "cancellation_fees"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" UUID,
  ADD COLUMN "voidReason" VARCHAR(500);

ALTER TABLE "cancellation_fees"
  ADD CONSTRAINT "cancellation_fees_voided_by_fkey"
    FOREIGN KEY ("voidedById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las tres juntas, solo en un cargo generado, con motivo de 3 a 500.
ALTER TABLE "cancellation_fees"
  ADD CONSTRAINT "cancellation_fees_void_check" CHECK (
    ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
    OR ("status" = 'CHARGED'
      AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
      AND "voidReason" IS NOT NULL
      AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)
  ) NOT VALID;
ALTER TABLE "cancellation_fees" VALIDATE CONSTRAINT "cancellation_fees_void_check";

-- La app sigue sin UPDATE de la fila: solo de las columnas de la anulación.
GRANT UPDATE ("voidedAt", "voidedById", "voidReason") ON "cancellation_fees" TO dentalix_app;

-- Ni DELETE ni otro UPDATE que la anulación, una sola vez y sin tocar nada
-- más: lo decidido (estado, importe, ítem, versión, autor) no se reescribe al
-- anular, y una anulación no se deshace ni cambia de motivo. Aplica a todo
-- rol (también con un GRANT de más) salvo el DELETE de un superusuario
-- (mantenimiento y limpieza de tests), como `dx_forbid_consent_mutation`
-- (DX-037). `pg_catalog.pg_roles` va calificado (SEC-032).
CREATE OR REPLACE FUNCTION public."cancellation_fees_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cancellation_fees es la prueba de lo cobrado o condonado: no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'el cargo ya está anulado: su anulación no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."voidedAt" IS NULL
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['voidedAt', 'voidedById', 'voidReason'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['voidedAt', 'voidedById', 'voidReason']) THEN
    RAISE EXCEPTION 'un cargo por cancelación solo se actualiza para anularlo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cancellation_fees_append_only"
  BEFORE UPDATE OR DELETE ON "cancellation_fees"
  FOR EACH ROW EXECUTE FUNCTION public."cancellation_fees_append_only"();

-- ---------------------------------------------------------------------------
-- 2. El ítem de un cargo vigente queda congelado.
-- ---------------------------------------------------------------------------
-- La búsqueda usa el índice (tenantId, patientId, planItemId) de la FK.
CREATE OR REPLACE FUNCTION public."treatment_plan_items_cancellation_fee_locked"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."price" IS NOT DISTINCT FROM OLD."price"
     AND NEW."discount" IS NOT DISTINCT FROM OLD."discount"
     AND NEW."discountReason" IS NOT DISTINCT FROM OLD."discountReason"
     AND NEW."discountReasonNote" IS NOT DISTINCT FROM OLD."discountReasonNote"
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt"
     AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
     AND NEW."catalogItemId" IS NOT DISTINCT FROM OLD."catalogItemId"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId"
     AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."cancellation_fees" f
     WHERE f."tenantId" = OLD."tenantId"
       AND f."patientId" = OLD."patientId"
       AND f."planItemId" = OLD."id"
       AND f."status" = 'CHARGED'
       AND f."voidedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'el ítem es un cargo por inasistencia o cancelación tardía vigente: su precio, descuento y estado no cambian ni se retira; se anula con la anulación del cargo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "treatment_plan_items_cancellation_fee_locked"
  BEFORE UPDATE OR DELETE ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plan_items_cancellation_fee_locked"();

-- ---------------------------------------------------------------------------
-- 3. El plan que lleva un cargo vigente no deja de cobrarse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."treatment_plans_cancellation_fee_locked"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN NEW;
  END IF;
  IF (NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" = 'COMPLETED')
     AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId"
     AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."treatment_plan_items" i
      JOIN public."cancellation_fees" f
        ON f."tenantId" = i."tenantId"
       AND f."patientId" = i."patientId"
       AND f."planItemId" = i."id"
     WHERE i."planId" = OLD."id"
       AND i."deletedAt" IS NULL
       AND f."status" = 'CHARGED'
       AND f."voidedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'el plan lleva un cargo por inasistencia o cancelación tardía vigente: no se cancela, rechaza ni cambia de moneda; anula antes el cargo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plans_cancellation_fee_locked"
  BEFORE UPDATE ON "treatment_plans"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plans_cancellation_fee_locked"();

ALTER TABLE "cancellation_fees" FORCE ROW LEVEL SECURITY;
