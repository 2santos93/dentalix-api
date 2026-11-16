-- DX-285: honorario del caso de ortodoncia, cobro de la inicial, de cada
-- control y del retiro en el plan ligado, y alineadores por arcada.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   tenants."orthoOverdueDays"   días tras los que un cargo de ortodoncia
--                       realizado y sin pagar marca «Ortodoncia: saldo
--                       vencido» (30 de fábrica). DEFAULT constante: solo
--                       metadatos. CHECK NOT VALID (se valida en
--                       20261230120100).
--   ortho_cases."fee*"  honorario total y su reparto: inicial, importe por
--                       control × controles cobrables y retiro, en la moneda
--                       del plan ligado (o de la sede). Todo NULL o todo con
--                       valor, y el reparto CUADRA con el total (CHECK NOT
--                       VALID; el caso nace sin honorario, así que todas las
--                       filas cumplen). Aceptado = sus cargos ya están en el
--                       plan: desde entonces el honorario y el plan ligado ya
--                       no cambian (guarda).
--   ortho_case_charges  qué ítem del plan es la inicial, el control n.º k o
--                       el retiro del caso, y qué control realizó el suyo.
--                       Únicos por (caso, tipo, n.º), por ítem y por
--                       control: un control nunca cobra dos veces (una
--                       adenda no crea control). Sin DELETE para la app.
--   ortho_aligner_series    serie de alineadores por arcada (superior,
--                       inferior o ambas): marca, n.º de bandejas y días por
--                       bandeja. Un refinamiento abre una serie nueva (con la
--                       anterior en "refinementOfId") sin perder la
--                       anterior. Append-only.
--   ortho_aligner_deliveries    entregas de bandejas (de la X a la Y, con
--                       fecha y, si fue en un control, ese control).
--                       Append-only.
--   ortho_visits_tenant_case_id_key   único (tenantId, caseId, id): destino
--                       de las FK que exigen que el control sea del MISMO
--                       caso. ortho_visits no es tabla caliente (DX-148).
--   dx_ortho_cases_guard()  la de 20261229190200 + el honorario aceptado y el
--                       plan ligado no cambian.
--
-- Ninguna tabla nueva tiene "patientId": cuelgan del caso por (tenantId,
-- caseId), así que la fusión de pacientes (DX-266) las arrastra con el caso
-- sin tocarlas y dx_patient_merge_tables() no cambia.
--
-- FK COMPUESTAS por tenant (SEC-004) dentro del CREATE TABLE (nacen vacías).
-- FK directa a tenants con RESTRICT. RLS ENABLE + FORCE con la política
-- NULLIF (DX-251). Funciones con search_path fijo y pg_temp al final.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_ortho_cases_guard con la
-- definición de 20261229190200 y
--   DROP TABLE public."ortho_aligner_deliveries";
--   DROP TABLE public."ortho_aligner_series";
--   DROP TABLE public."ortho_case_charges";
--   DROP INDEX public."ortho_visits_tenant_case_id_key";
--   DROP TYPE "OrthoAlignerArch", "OrthoChargeKind";
--   ALTER TABLE public."ortho_cases" DROP CONSTRAINT "ortho_cases_fee_check",
--     DROP CONSTRAINT "ortho_cases_fee_currency_fkey",
--     DROP CONSTRAINT "ortho_cases_fee_payment_plan_fkey",
--     DROP CONSTRAINT "ortho_cases_fee_actor_check", DROP COLUMN "feeCurrency",
--     DROP COLUMN "feeTotal", DROP COLUMN "feeInitial", DROP COLUMN "feePerVisit",
--     DROP COLUMN "feeVisitCount", DROP COLUMN "feeRetention",
--     DROP COLUMN "feeUpdatedAt", DROP COLUMN "feeUpdatedById",
--     DROP COLUMN "feeAcceptedAt", DROP COLUMN "feeAcceptedById",
--     DROP COLUMN "feePaymentPlanId";
--   ALTER TABLE public."tenants" DROP COLUMN "orthoOverdueDays";

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Ajuste de la clínica
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN "orthoOverdueDays" SMALLINT NOT NULL DEFAULT 30;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ortho_overdue_days_check"
  CHECK ("orthoOverdueDays" BETWEEN 1 AND 365) NOT VALID;

-- ---------------------------------------------------------------------------
-- Honorario del caso
-- ---------------------------------------------------------------------------
ALTER TABLE "ortho_cases"
  ADD COLUMN "feeCurrency" CHAR(3),
  ADD COLUMN "feeTotal" DECIMAL(14,2),
  ADD COLUMN "feeInitial" DECIMAL(12,2),
  ADD COLUMN "feePerVisit" DECIMAL(12,2),
  ADD COLUMN "feeVisitCount" SMALLINT,
  ADD COLUMN "feeRetention" DECIMAL(12,2),
  ADD COLUMN "feeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "feeUpdatedById" UUID,
  ADD COLUMN "feeAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "feeAcceptedById" UUID,
  ADD COLUMN "feePaymentPlanId" UUID;

-- FK bajo FORCE (DX-134): añadirla valida leyendo la hija con la RLS del
-- owner, así que se quita FORCE a la hija (ortho_cases) y a la referenciada
-- con RLS (payment_plans) y se devuelve al final de este bloque. Las columnas
-- acaban de nacer en NULL: la validación no encuentra nada que comprobar.
-- ACCESS EXCLUSIVE sobre las dos hasta el COMMIT (lock_timeout arriba);
-- currencies no tiene RLS.
ALTER TABLE "ortho_cases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" NO FORCE ROW LEVEL SECURITY;

-- La moneda existe en el catálogo (como la del plan, DX-042).
ALTER TABLE "ortho_cases" ADD CONSTRAINT "ortho_cases_fee_currency_fkey"
  FOREIGN KEY ("feeCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Si al aceptar el plan ligado ya tenía un plan de cuotas ACTIVE, los cargos
-- NO se crean (las cuotas ya cobran el tratamiento): la cuenta lo informa.
ALTER TABLE "ortho_cases" ADD CONSTRAINT "ortho_cases_fee_payment_plan_fkey"
  FOREIGN KEY ("tenantId", "feePaymentPlanId") REFERENCES "payment_plans"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ortho_cases" FORCE ROW LEVEL SECURITY;

-- Todo o nada, importes no negativos, total positivo y el reparto CUADRA
-- (la API responde 400 en español antes). Aceptado solo con honorario.
ALTER TABLE "ortho_cases" ADD CONSTRAINT "ortho_cases_fee_check" CHECK (
  (
    "feeCurrency" IS NULL AND "feeTotal" IS NULL AND "feeInitial" IS NULL
    AND "feePerVisit" IS NULL AND "feeVisitCount" IS NULL
    AND "feeRetention" IS NULL AND "feeAcceptedAt" IS NULL
  )
  OR (
    "feeCurrency" IS NOT NULL AND "feeTotal" IS NOT NULL
    AND "feeInitial" IS NOT NULL AND "feePerVisit" IS NOT NULL
    AND "feeVisitCount" IS NOT NULL AND "feeRetention" IS NOT NULL
    AND "feeTotal" > 0 AND "feeInitial" >= 0 AND "feePerVisit" >= 0
    AND "feeRetention" >= 0 AND "feeVisitCount" BETWEEN 0 AND 240
    AND "feeTotal" = "feeInitial" + "feePerVisit" * "feeVisitCount" + "feeRetention"
  )
) NOT VALID;
ALTER TABLE "ortho_cases" ADD CONSTRAINT "ortho_cases_fee_actor_check" CHECK (
  ("feeAcceptedAt" IS NULL) = ("feeAcceptedById" IS NULL)
  AND ("feeUpdatedAt" IS NULL) = ("feeUpdatedById" IS NULL)
  AND ("feePaymentPlanId" IS NULL OR "feeAcceptedAt" IS NOT NULL)
) NOT VALID;

-- Lado hijo de la FK al plan de cuotas (casi siempre NULL). ortho_cases no es
-- tabla caliente.
CREATE INDEX "ortho_cases_fee_payment_plan_idx"
  ON "ortho_cases"("tenantId", "feePaymentPlanId") WHERE "feePaymentPlanId" IS NOT NULL;

-- Guarda de 20261229190200 + el honorario aceptado y el plan ligado ya no
-- cambian (sus cargos están en ese plan).
CREATE OR REPLACE FUNCTION public.dx_ortho_cases_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ortho_cases es historia clínica: no se permite % de un caso de ortodoncia (DX-190)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" IN ('FINISHED', 'ABANDONED') THEN
    RAISE EXCEPTION 'ortho_cases: un caso de ortodoncia cerrado no se modifica (DX-190)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ortho_cases: la clínica, el paciente, el autor y la fecha de alta de un caso no cambian (DX-190)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- DX-285: con el honorario aceptado, sus cargos viven en el plan ligado.
  IF OLD."feeAcceptedAt" IS NOT NULL AND (
       NEW."feeAcceptedAt" IS DISTINCT FROM OLD."feeAcceptedAt"
       OR NEW."feeAcceptedById" IS DISTINCT FROM OLD."feeAcceptedById"
       OR NEW."feeCurrency" IS DISTINCT FROM OLD."feeCurrency"
       OR NEW."feeTotal" IS DISTINCT FROM OLD."feeTotal"
       OR NEW."feeInitial" IS DISTINCT FROM OLD."feeInitial"
       OR NEW."feePerVisit" IS DISTINCT FROM OLD."feePerVisit"
       OR NEW."feeVisitCount" IS DISTINCT FROM OLD."feeVisitCount"
       OR NEW."feeRetention" IS DISTINCT FROM OLD."feeRetention"
       OR NEW."feePaymentPlanId" IS DISTINCT FROM OLD."feePaymentPlanId"
       OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId") THEN
    RAISE EXCEPTION 'ortho_cases: el honorario aceptado y el plan ligado de un caso no cambian (DX-285)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Destino de FK: el control del MISMO caso
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "ortho_visits_tenant_case_id_key"
  ON "ortho_visits"("tenantId", "caseId", "id");

-- ---------------------------------------------------------------------------
-- Cargos del caso en el plan
-- ---------------------------------------------------------------------------
CREATE TYPE "OrthoChargeKind" AS ENUM ('INITIAL', 'VISIT', 'RETENTION');

CREATE TABLE "ortho_case_charges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "kind" "OrthoChargeKind" NOT NULL,
    -- N.º del control (1..240); 0 en la inicial y el retiro.
    "sequence" SMALLINT NOT NULL,
    "planId" UUID NOT NULL,
    "planItemId" UUID NOT NULL,
    -- El control que realizó este cargo (solo los de tipo VISIT).
    "visitId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ortho_case_charges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ortho_case_charges_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_case_charges_case_fkey"
      FOREIGN KEY ("tenantId", "caseId") REFERENCES "ortho_cases"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El ítem es del MISMO tenant y de ese plan.
    CONSTRAINT "ortho_case_charges_item_fkey"
      FOREIGN KEY ("tenantId", "planItemId", "planId")
      REFERENCES "treatment_plan_items"("tenantId", "id", "planId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El control es del MISMO caso.
    CONSTRAINT "ortho_case_charges_visit_fkey"
      FOREIGN KEY ("tenantId", "caseId", "visitId")
      REFERENCES "ortho_visits"("tenantId", "caseId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_case_charges_kind_check" CHECK (
      ("kind" = 'VISIT' AND "sequence" BETWEEN 1 AND 240)
      OR ("kind" <> 'VISIT' AND "sequence" = 0 AND "visitId" IS NULL)
    )
);

CREATE UNIQUE INDEX "ortho_case_charges_case_kind_key"
  ON "ortho_case_charges"("tenantId", "caseId", "kind", "sequence");
-- Un ítem es UN cargo; también es el lado hijo de la FK al ítem.
CREATE UNIQUE INDEX "ortho_case_charges_item_key"
  ON "ortho_case_charges"("tenantId", "planItemId");
-- Un control realiza como mucho UN cargo; lado hijo de la FK al control.
CREATE UNIQUE INDEX "ortho_case_charges_visit_key"
  ON "ortho_case_charges"("tenantId", "visitId") WHERE "visitId" IS NOT NULL;

ALTER TABLE "ortho_case_charges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ortho_case_charges"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ortho_case_charges" FORCE ROW LEVEL SECURITY;

-- La app crea los cargos y apunta el control que realiza cada uno; nunca borra.
REVOKE DELETE, TRUNCATE ON "ortho_case_charges" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Alineadores
-- ---------------------------------------------------------------------------
CREATE TYPE "OrthoAlignerArch" AS ENUM ('UPPER', 'LOWER', 'BOTH');

CREATE TABLE "ortho_aligner_series" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "arch" "OrthoAlignerArch" NOT NULL,
    "brand" TEXT NOT NULL,
    "totalTrays" SMALLINT NOT NULL,
    "daysPerTray" SMALLINT NOT NULL,
    -- La serie que este refinamiento continúa (del MISMO caso).
    "refinementOfId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ortho_aligner_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ortho_aligner_series_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_series_case_fkey"
      FOREIGN KEY ("tenantId", "caseId") REFERENCES "ortho_cases"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_series_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_series_values_check" CHECK (
      char_length(btrim("brand")) BETWEEN 1 AND 60
      AND "totalTrays" BETWEEN 1 AND 99
      AND "daysPerTray" BETWEEN 1 AND 60
      AND ("refinementOfId" IS NULL OR "refinementOfId" <> "id")
    )
);

CREATE UNIQUE INDEX "ortho_aligner_series_tenant_case_id_key"
  ON "ortho_aligner_series"("tenantId", "caseId", "id");
-- Tabla nueva y vacía: la FK a sí misma va tras su índice de destino.
ALTER TABLE "ortho_aligner_series" ADD CONSTRAINT "ortho_aligner_series_refinement_fkey"
  FOREIGN KEY ("tenantId", "caseId", "refinementOfId")
  REFERENCES "ortho_aligner_series"("tenantId", "caseId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- Las series del caso (pestaña) por orden; el prefijo sirve la FK al caso.
CREATE INDEX "ortho_aligner_series_case_created_idx"
  ON "ortho_aligner_series"("tenantId", "caseId", "createdAt");
CREATE INDEX "ortho_aligner_series_refinement_idx"
  ON "ortho_aligner_series"("tenantId", "caseId", "refinementOfId")
  WHERE "refinementOfId" IS NOT NULL;
CREATE INDEX "ortho_aligner_series_created_by_idx"
  ON "ortho_aligner_series"("createdById");

ALTER TABLE "ortho_aligner_series" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ortho_aligner_series"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ortho_aligner_series" FORCE ROW LEVEL SECURITY;

-- Append-only (DX-148): la app solo lee e inserta.
REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_aligner_series" FROM dentalix_app;

CREATE TABLE "ortho_aligner_deliveries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "fromTray" SMALLINT NOT NULL,
    "toTray" SMALLINT NOT NULL,
    -- Día civil de la entrega (zona de la sede del caso).
    "deliveredOn" DATE NOT NULL,
    -- El control en el que se entregó (del MISMO caso), si fue en uno.
    "visitId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ortho_aligner_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ortho_aligner_deliveries_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_deliveries_series_fkey"
      FOREIGN KEY ("tenantId", "caseId", "seriesId")
      REFERENCES "ortho_aligner_series"("tenantId", "caseId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_deliveries_visit_fkey"
      FOREIGN KEY ("tenantId", "caseId", "visitId")
      REFERENCES "ortho_visits"("tenantId", "caseId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_deliveries_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_aligner_deliveries_trays_check" CHECK (
      "fromTray" BETWEEN 1 AND 99 AND "toTray" BETWEEN "fromTray" AND 99
    )
);

-- Una bandeja se entrega una vez por serie (la API exige además que las
-- entregas sean seguidas, con el caso bloqueado).
CREATE UNIQUE INDEX "ortho_aligner_deliveries_series_from_key"
  ON "ortho_aligner_deliveries"("tenantId", "seriesId", "fromTray");
-- Entregas de las series del caso; el prefijo sirve la FK a la serie.
CREATE INDEX "ortho_aligner_deliveries_case_series_idx"
  ON "ortho_aligner_deliveries"("tenantId", "caseId", "seriesId");
CREATE INDEX "ortho_aligner_deliveries_visit_idx"
  ON "ortho_aligner_deliveries"("tenantId", "caseId", "visitId")
  WHERE "visitId" IS NOT NULL;
CREATE INDEX "ortho_aligner_deliveries_created_by_idx"
  ON "ortho_aligner_deliveries"("createdById");

ALTER TABLE "ortho_aligner_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ortho_aligner_deliveries"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ortho_aligner_deliveries" FORCE ROW LEVEL SECURITY;

-- Append-only (DX-148): la app solo lee e inserta.
REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_aligner_deliveries" FROM dentalix_app;
