-- DX-018: honorarios de odontólogos a porcentaje. Regla por profesional y
-- liquidación del período, congelada con su detalle.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   enums CommissionBasis (COLLECTED/PRODUCED), CommissionReleaseMode
--   (PER_ITEM/PER_PLAN) y CommissionLineKind (ACCRUAL/ADJUSTMENT).
--   commission_rules            una regla por membresía: base, cuándo se
--                               libera, % general (0–100) y activa. FK
--                               COMPUESTA (tenantId, membershipId, userId) a
--                               clinic_memberships: la membresía es de la
--                               MISMA clínica y del MISMO usuario. Sin DELETE
--                               para la app: se desactiva.
--   commission_rule_categories  % por categoría del catálogo (única por regla
--                               sin distinguir mayúsculas). Se reemplaza al
--                               guardar la regla (DELETE + INSERT).
--   commission_settlements      liquidación cerrada (APPEND-ONLY): profesional,
--                               período, foto de la regla y el cierre contable
--                               antes/después. Sin solapes por profesional
--                               (EXCLUDE gist sobre el rango de fechas).
--   commission_settlement_lines detalle congelado (APPEND-ONLY): devengo por
--                               ítem (producido) o por imputación abono→ítem
--                               (cobrado), y ajustes de líneas anteriores. FK
--                               compuestas al abono, al ítem (y su plan), a la
--                               sede, a la línea ajustada y a la liquidación
--                               (con el MISMO usuario). Un devengo no se repite
--                               para el mismo profesional (único parcial).
--
-- Sin columnas hacia patients: el paciente se lee por el ítem del plan (la
-- fusión de pacientes, DX-266, ya lo reasigna allí); dx_merge_patients no
-- cambia.
--
-- FK sobre tablas con RLS FORCE (DX-134): van DENTRO de los CREATE TABLE
-- (nacen vacías: la validación no lee filas). FK directa a tenants con
-- RESTRICT. RLS ENABLE + FORCE con la política NULLIF (DX-251). Funciones con
-- search_path fijo y pg_temp al final (SEC-032). Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app; aquí se le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."commission_settlement_lines";
--   DROP TABLE public."commission_settlements";
--   DROP TABLE public."commission_rule_categories";
--   DROP TABLE public."commission_rules";
--   DROP FUNCTION public.dx_commission_settlement_guard();
--   DROP FUNCTION public.dx_commission_rule_guard();
--   DROP TYPE "CommissionLineKind"; DROP TYPE "CommissionReleaseMode";
--   DROP TYPE "CommissionBasis";

SET LOCAL lock_timeout = '5s';

CREATE TYPE "CommissionBasis" AS ENUM ('COLLECTED', 'PRODUCED');
CREATE TYPE "CommissionReleaseMode" AS ENUM ('PER_ITEM', 'PER_PLAN');
CREATE TYPE "CommissionLineKind" AS ENUM ('ACCRUAL', 'ADJUSTMENT');

-- ---------------------------------------------------------------------------
-- commission_rules
-- ---------------------------------------------------------------------------

-- Una regla nunca se borra (se desactiva) y no cambia de clínica, membresía,
-- usuario ni fecha de alta. DELETE/TRUNCATE solo un superusuario (purga
-- administrativa y limpieza de las bases de test).
CREATE FUNCTION public.dx_commission_rule_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'commission_rules: una regla de honorarios no se borra, se desactiva (DX-018)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."membershipId" IS DISTINCT FROM OLD."membershipId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'commission_rules: la clínica, el profesional y la fecha de alta no cambian (DX-018)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "commission_rules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "basis" "CommissionBasis" NOT NULL,
    "releaseMode" "CommissionReleaseMode" NOT NULL DEFAULT 'PER_ITEM',
    "percent" DECIMAL(5,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_rules_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La membresía es de la MISMA clínica y del MISMO usuario (SEC-004).
    CONSTRAINT "commission_rules_membership_fkey"
      FOREIGN KEY ("tenantId", "membershipId", "userId")
      REFERENCES "clinic_memberships"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_rules_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_rules_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_rules_percent_check" CHECK ("percent" >= 0 AND "percent" <= 100)
);

-- Una regla por profesional de la clínica; destino de la FK de categorías.
CREATE UNIQUE INDEX "commission_rules_tenant_membership_key"
  ON "commission_rules"("tenantId", "membershipId");
CREATE UNIQUE INDEX "commission_rules_tenant_id_key" ON "commission_rules"("tenantId", "id");
-- Lados hijos de las FK.
CREATE INDEX "commission_rules_membership_user_idx"
  ON "commission_rules"("tenantId", "membershipId", "userId");
CREATE INDEX "commission_rules_created_by_idx" ON "commission_rules"("createdById");
CREATE INDEX "commission_rules_updated_by_idx" ON "commission_rules"("updatedById");

CREATE TRIGGER "commission_rules_guard"
  BEFORE UPDATE OR DELETE ON "commission_rules"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_rule_guard();
CREATE TRIGGER "commission_rules_no_truncate"
  BEFORE TRUNCATE ON "commission_rules"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_rule_guard();

ALTER TABLE "commission_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_rules"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_rules" FORCE ROW LEVEL SECURITY;

-- La app lee, crea y actualiza (también desactiva); nunca borra.
REVOKE DELETE, TRUNCATE ON "commission_rules" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- commission_rule_categories
-- ---------------------------------------------------------------------------
CREATE TABLE "commission_rule_categories" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "commission_rule_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_rule_categories_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_rule_categories_rule_fkey"
      FOREIGN KEY ("tenantId", "ruleId") REFERENCES "commission_rules"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_rule_categories_values_check" CHECK (
      char_length(btrim("category")) BETWEEN 1 AND 120
      AND "category" = btrim("category")
      AND "percent" >= 0 AND "percent" <= 100
    )
);

-- Una categoría por regla, sin distinguir mayúsculas (la API responde 400 antes).
CREATE UNIQUE INDEX "commission_rule_categories_rule_category_key"
  ON "commission_rule_categories"("tenantId", "ruleId", lower("category"));

ALTER TABLE "commission_rule_categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_rule_categories"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_rule_categories" FORCE ROW LEVEL SECURITY;

REVOKE TRUNCATE ON "commission_rule_categories" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Guarda append-only de la liquidación y su detalle
-- ---------------------------------------------------------------------------

-- Una liquidación cerrada (y cada línea) es inalterable: sin UPDATE; DELETE y
-- TRUNCATE solo un superusuario (purga y limpieza de test). Al insertar, la
-- hora del cierre es la del servidor en UTC (DX-226), nunca la de la app.
CREATE FUNCTION public.dx_commission_settlement_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% no admite %: una liquidación de honorarios cerrada no se borra (DX-018)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% es inalterable: una liquidación cerrada se corrige con ajustes en la siguiente (DX-018)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'commission_settlements' THEN
    NEW."closedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- commission_settlements
-- ---------------------------------------------------------------------------
CREATE TABLE "commission_settlements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "basis" "CommissionBasis" NOT NULL,
    "releaseMode" "CommissionReleaseMode" NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "categoryPercents" JSONB NOT NULL DEFAULT '[]',
    "lockDateBefore" DATE,
    "lockDateAfter" DATE NOT NULL,
    "closedById" UUID NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_settlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_settlements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlements_membership_fkey"
      FOREIGN KEY ("tenantId", "membershipId", "userId")
      REFERENCES "clinic_memberships"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlements_closed_by_fkey"
      FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlements_values_check" CHECK (
      "periodFrom" <= "periodTo"
      AND "percent" >= 0 AND "percent" <= 100
      AND jsonb_typeof("categoryPercents") = 'array'
      -- El cierre contable queda al menos en el último día del período.
      AND "lockDateAfter" >= "periodTo"
      AND ("lockDateBefore" IS NULL OR "lockDateAfter" >= "lockDateBefore")
    ),
    -- Dos liquidaciones del mismo profesional nunca se solapan.
    CONSTRAINT "commission_settlements_no_overlap"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "membershipId" WITH =,
        daterange("periodFrom", "periodTo", '[]') WITH &&
      )
);

-- Destino de la FK de las líneas (con el MISMO usuario) y de las búsquedas por id.
CREATE UNIQUE INDEX "commission_settlements_tenant_id_user_key"
  ON "commission_settlements"("tenantId", "id", "userId");
-- Las liquidaciones de un profesional, de la más reciente a la más antigua.
CREATE INDEX "commission_settlements_user_period_idx"
  ON "commission_settlements"("tenantId", "userId", "periodTo" DESC);
-- La lista de la clínica por período.
CREATE INDEX "commission_settlements_tenant_period_idx"
  ON "commission_settlements"("tenantId", "periodTo" DESC);
CREATE INDEX "commission_settlements_membership_user_idx"
  ON "commission_settlements"("tenantId", "membershipId", "userId");
CREATE INDEX "commission_settlements_closed_by_idx" ON "commission_settlements"("closedById");

CREATE TRIGGER "commission_settlements_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_settlements"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_settlement_guard();
CREATE TRIGGER "commission_settlements_no_truncate"
  BEFORE TRUNCATE ON "commission_settlements"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_settlement_guard();

ALTER TABLE "commission_settlements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_settlements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_settlements" FORCE ROW LEVEL SECURITY;

-- Append-only (DX-148): la app solo lee e inserta.
REVOKE UPDATE, DELETE, TRUNCATE ON "commission_settlements" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- commission_settlement_lines
-- ---------------------------------------------------------------------------
CREATE TABLE "commission_settlement_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "CommissionLineKind" NOT NULL,
    "adjustsLineId" UUID,
    "treatmentPlanId" UUID NOT NULL,
    "treatmentPlanItemId" UUID NOT NULL,
    "paymentId" UUID,
    "locationId" UUID,
    "catalogCode" TEXT NOT NULL,
    "catalogLabel" TEXT NOT NULL,
    "category" TEXT,
    "toothNumber" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentAmount" DECIMAL(14,2),
    "paymentCurrency" CHAR(3),
    "releasedAt" TIMESTAMP(3),
    "currency" CHAR(3) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "commission_settlement_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_settlement_lines_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La liquidación, de la MISMA clínica y del MISMO profesional.
    CONSTRAINT "commission_settlement_lines_settlement_fkey"
      FOREIGN KEY ("tenantId", "settlementId", "userId")
      REFERENCES "commission_settlements"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El ítem y su plan, de la MISMA clínica.
    CONSTRAINT "commission_settlement_lines_item_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanItemId", "treatmentPlanId")
      REFERENCES "treatment_plan_items"("tenantId", "id", "planId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El abono (cobrado), de la MISMA clínica Y del MISMO plan.
    CONSTRAINT "commission_settlement_lines_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId")
      REFERENCES "payments"("tenantId", "id", "treatmentPlanId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlement_lines_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlement_lines_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlement_lines_payment_currency_fkey"
      FOREIGN KEY ("paymentCurrency") REFERENCES "currencies"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_settlement_lines_values_check" CHECK (
      "percent" >= 0 AND "percent" <= 100
      AND char_length("catalogCode") BETWEEN 1 AND 200
      AND char_length("catalogLabel") BETWEEN 1 AND 500
      AND ("paymentId" IS NULL) = ("paymentAmount" IS NULL)
      AND ("paymentAmount" IS NULL) = ("paymentCurrency" IS NULL)
      AND ("paymentAmount" IS NULL) = ("paidAt" IS NULL)
    ),
    -- Un devengo es positivo y no ajusta nada; un ajuste nombra la línea que
    -- corrige y no es cero.
    CONSTRAINT "commission_settlement_lines_kind_check" CHECK (
      ("kind" = 'ACCRUAL' AND "adjustsLineId" IS NULL AND "base" > 0 AND "amount" >= 0
        AND "releasedAt" IS NOT NULL)
      OR ("kind" = 'ADJUSTMENT' AND "adjustsLineId" IS NOT NULL AND "base" <> 0)
    )
);

-- Destino de la FK de los ajustes.
CREATE UNIQUE INDEX "commission_settlement_lines_tenant_id_key"
  ON "commission_settlement_lines"("tenantId", "id");
ALTER TABLE "commission_settlement_lines" ADD CONSTRAINT "commission_settlement_lines_adjusts_fkey"
  FOREIGN KEY ("tenantId", "adjustsLineId") REFERENCES "commission_settlement_lines"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- Un devengo (ítem, o ítem + abono) no se paga dos veces al mismo profesional.
CREATE UNIQUE INDEX "commission_settlement_lines_accrual_key"
  ON "commission_settlement_lines"(
    "tenantId", "userId", "treatmentPlanItemId",
    COALESCE("paymentId", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "kind" = 'ACCRUAL';
-- El detalle de una liquidación (y lado hijo de su FK).
CREATE INDEX "commission_settlement_lines_settlement_idx"
  ON "commission_settlement_lines"("tenantId", "settlementId", "userId");
-- Lo ya liquidado de un profesional (exclusión de devengos y ajustes).
CREATE INDEX "commission_settlement_lines_user_item_idx"
  ON "commission_settlement_lines"("tenantId", "userId", "treatmentPlanItemId");
-- Lados hijos de las demás FK.
CREATE INDEX "commission_settlement_lines_item_idx"
  ON "commission_settlement_lines"("tenantId", "treatmentPlanItemId", "treatmentPlanId");
CREATE INDEX "commission_settlement_lines_payment_idx"
  ON "commission_settlement_lines"("tenantId", "paymentId", "treatmentPlanId");
CREATE INDEX "commission_settlement_lines_adjusts_idx"
  ON "commission_settlement_lines"("tenantId", "adjustsLineId");
CREATE INDEX "commission_settlement_lines_location_idx"
  ON "commission_settlement_lines"("tenantId", "locationId");
CREATE INDEX "commission_settlement_lines_currency_idx"
  ON "commission_settlement_lines"("currency");
CREATE INDEX "commission_settlement_lines_payment_currency_idx"
  ON "commission_settlement_lines"("paymentCurrency");

CREATE TRIGGER "commission_settlement_lines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_settlement_lines"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_settlement_guard();
CREATE TRIGGER "commission_settlement_lines_no_truncate"
  BEFORE TRUNCATE ON "commission_settlement_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_settlement_guard();

ALTER TABLE "commission_settlement_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_settlement_lines"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_settlement_lines" FORCE ROW LEVEL SECURITY;

REVOKE UPDATE, DELETE, TRUNCATE ON "commission_settlement_lines" FROM dentalix_app;
