-- DX-012: presupuesto imprimible del plan de tratamiento y aceptación firmada.
--
-- Cambios:
--   treatment_plan_items.discount  descuento del ítem en la moneda del plan
--                                  (0 por defecto; nunca mayor que el precio).
--   treatment_plan_acceptances     aceptación FIRMADA del presupuesto: foto del
--                                  contenido presentado (JSONB), su SHA-256, la
--                                  firma (PNG base64), quién firmó, cuándo y en
--                                  qué sede. Una por plan; append-only.
--   triggers                       un plan aceptado con firma no admite cambios
--                                  en sus ítems ni en su moneda, ni vuelve a
--                                  borrador; la aceptación no se edita.
--
-- Compatible hacia atrás: solo AÑADE (una columna con DEFAULT constante, que
-- Postgres no reescribe; una tabla con sus índices, FK, CHECK, RLS y triggers).
-- Mientras no exista ninguna aceptación los triggers no cambian nada, así que el
-- código anterior sigue funcionando igual.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261016180000_patient_consents).

-- ---------------------------------------------------------------------------
-- treatment_plan_items.discount
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_items" ADD COLUMN "discount" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- Todas las filas existentes valen 0, así que los CHECK no pueden fallar al
-- crearse. El subtotal (precio − descuento) nunca es negativo: el descuento no
-- supera el precio. (Postgres evalúa los CHECK por orden de nombre, así que un
-- precio negativo sigue reportándose como treatment_plan_items_price_nonneg.)
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_discount_nonneg"
  CHECK ("discount" >= 0);
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_subtotal_nonneg"
  CHECK ("price" - "discount" >= 0);

-- ---------------------------------------------------------------------------
-- treatment_plan_acceptances
-- ---------------------------------------------------------------------------
CREATE TABLE "treatment_plan_acceptances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "signerName" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "acceptanceHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "acceptedById" UUID NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treatment_plan_acceptances_pkey" PRIMARY KEY ("id"),
    -- SHA-256 en hex, siempre 64 caracteres en minúscula.
    CONSTRAINT "treatment_plan_acceptances_content_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "treatment_plan_acceptances_acceptance_hash_check" CHECK ("acceptanceHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "treatment_plan_acceptances_signer_name_check" CHECK (length(btrim("signerName")) BETWEEN 1 AND 200),
    -- Mismo tope que las firmas de patient_consents: 200 KB decodificados
    -- = 273068 caracteres de base64. La API valida antes (400); esto es la red.
    CONSTRAINT "treatment_plan_acceptances_signature_check" CHECK (length("signature") BETWEEN 1 AND 273068),
    CONSTRAINT "treatment_plan_acceptances_content_check" CHECK (jsonb_typeof("content") = 'object')
);

-- UNA aceptación por plan: volver a firmar choca aquí (409 en la API), también
-- con dos firmas simultáneas. Es además el lado hijo de la FK compuesta al plan
-- (empieza por tenantId, planId) y el índice de la búsqueda por plan.
CREATE UNIQUE INDEX "treatment_plan_acceptances_plan_key" ON "treatment_plan_acceptances"("tenantId", "planId", "patientId");
-- Aceptaciones de un paciente y de una sede (lado hijo de esas FK).
CREATE INDEX "treatment_plan_acceptances_tenantId_patientId_idx" ON "treatment_plan_acceptances"("tenantId", "patientId");
CREATE INDEX "treatment_plan_acceptances_tenantId_locationId_idx" ON "treatment_plan_acceptances"("tenantId", "locationId");
CREATE INDEX "treatment_plan_acceptances_acceptedById_idx" ON "treatment_plan_acceptances"("acceptedById");

-- FK COMPUESTAS por tenant (SEC-004, patrón de 20261015130000): las FK de
-- Postgres se chequean saltando la RLS, así que con FK simples una aceptación
-- de la clínica A podría apuntar a un plan o a una sede de la clínica B. El
-- plan, además, del MISMO paciente. RESTRICT: es un documento firmado. (Sin
-- FK propia a tenants, como patient_consents: la del plan ya la implica.)
ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_tenantId_planId_patientId_fkey"
  FOREIGN KEY ("tenantId", "planId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad de la aceptación (mismo criterio que patient_consents):
--   - UPDATE: siempre rechazado.
--   - DELETE: rechazado dentro de un contexto de tenant (la app); fuera de él
--     (rol owner, limpieza de una base de test) se permite.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "treatment_plan_acceptances_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'treatment_plan_acceptances es inmutable: una aceptación firmada no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'treatment_plan_acceptances es inmutable: una aceptación firmada no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "treatment_plan_acceptances_immutable"
  BEFORE UPDATE OR DELETE ON "treatment_plan_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "treatment_plan_acceptances_immutable"();

-- ---------------------------------------------------------------------------
-- Ítems de un plan aceptado con firma: congelados. La API responde 409 antes;
-- esto lo hace imposible aunque una ruta futura se lo salte.
--   - INSERT: rechazado.
--   - UPDATE: solo el avance del estado (ACEPTADO <-> REALIZADO); cualquier otra
--     columna (diente, caras, procedimiento, precio, descuento, notas, retirar
--     con deletedAt) o volver a PROPUESTO se rechaza.
--   - DELETE: rechazado dentro de un contexto de tenant; fuera de él (owner,
--     limpieza de una base de test) se permite.
-- Bloquea la fila del plan (FOR SHARE) antes de mirar si está aceptado: la
-- aceptación bloquea esa fila FOR UPDATE, así que un cambio concurrente espera
-- a que la firma termine y entonces la ve (no se cuela un ítem entre la foto
-- firmada y el COMMIT).
-- ---------------------------------------------------------------------------
CREATE FUNCTION "treatment_plan_items_locked_when_accepted"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  PERFORM 1 FROM "treatment_plans" WHERE "id" = plan_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM "treatment_plan_acceptances" WHERE "planId" = plan_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: no admite ítems nuevos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."toothNumber" IS DISTINCT FROM OLD."toothNumber"
     OR NEW."surfaces" IS DISTINCT FROM OLD."surfaces"
     OR NEW."catalogItemId" IS DISTINCT FROM OLD."catalogItemId"
     OR NEW."price" IS DISTINCT FROM OLD."price"
     OR NEW."discount" IS DISTINCT FROM OLD."discount"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR (NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED') THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plan_items_locked_when_accepted"
  BEFORE INSERT OR UPDATE OR DELETE ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "treatment_plan_items_locked_when_accepted"();

-- ---------------------------------------------------------------------------
-- Plan aceptado con firma: su moneda (los importes firmados) no cambia y no
-- vuelve a borrador. Cerrarlo (COMPLETED / CANCELLED) y las notas, sí.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "treatment_plans_locked_when_accepted"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."currency" IS DISTINCT FROM OLD."currency"
      OR (NEW."status" = 'DRAFT' AND OLD."status" <> 'DRAFT')
      OR NEW."patientId" IS DISTINCT FROM OLD."patientId")
     AND EXISTS (SELECT 1 FROM "treatment_plan_acceptances" WHERE "planId" = OLD."id") THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: su moneda no cambia ni vuelve a borrador'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plans_locked_when_accepted"
  BEFORE UPDATE ON "treatment_plans"
  FOR EACH ROW EXECUTE FUNCTION "treatment_plans_locked_when_accepted"();

-- ---------------------------------------------------------------------------
-- RLS por tenant (mismo patrón que patient_consents).
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_acceptances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "treatment_plan_acceptances"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
