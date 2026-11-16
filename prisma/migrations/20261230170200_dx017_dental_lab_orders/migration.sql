-- DX-017: laboratorio dental (protésico): catálogo de laboratorios de la
-- clínica con sus servicios y órdenes de laboratorio (la prescripción escrita
-- del producto a medida), ligadas al ítem del plan y a la cita de colocación.
-- NO confundir con external_orders (DX-572: imagen, análisis y especialistas).
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   dental_labs          laboratorio de la clínica: nombre (1–120, único por
--                        clínica sin distinguir mayúsculas), contacto,
--                        teléfono, email, notas y activo. Sin DELETE para la
--                        app: se desactiva.
--   dental_lab_services  servicio del laboratorio: nombre (único por
--                        laboratorio), plazo en días hábiles (0–120) y precio
--                        de referencia opcional con su moneda (juntos o
--                        ninguno). Sin DELETE para la app.
--   dental_lab_orders    la orden. FK COMPUESTAS por clínica a sede,
--                        paciente, membresía del profesional, laboratorio,
--                        servicio (del MISMO laboratorio), ítem del plan y
--                        cita de colocación (los dos del MISMO paciente) y
--                        orden corregida (de la misma clínica; el trigger
--                        exige el MISMO paciente). Número correlativo por
--                        clínica bajo un candado consultivo. Estado DERIVADO
--                        de las fechas (enviada, recibida, revisada,
--                        anulada); el orden de las fechas y los pares
--                        fecha/autor van en CHECK. Guarda: nunca se borra (se
--                        anula con motivo), una anulada no cambia, tras
--                        «Enviada» el contenido no cambia (solo la fecha
--                        prometida y la cita) y una fecha puesta no cambia ni
--                        se quita. Abre la puerta de la fusión (DX-266).
--   dx017_valid_teeth(text[])  dientes FDI sin NULL, sin repetir, 0–32 (CHECK).
--   dx_patient_merge_tables()  la de DX-190 (20261229190200) +
--                        dental_lab_orders.patientId (lista cerrada de DX-266).
--
-- FK sobre tablas con RLS FORCE (DX-134): las de las tablas nuevas van DENTRO
-- de los CREATE TABLE (nacen vacías: la validación no lee filas). FK directa
-- a tenants con RESTRICT. RLS ENABLE + FORCE con la política NULLIF (DX-251).
-- Funciones con search_path fijo y pg_temp al final (SEC-032). Grants: ALTER
-- DEFAULT PRIVILEGES ya cubre a dentalix_app; aquí se le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables con
-- la definición de 20261229190200 y
--   DROP TABLE public."dental_lab_orders"; DROP TABLE public."dental_lab_services";
--   DROP TABLE public."dental_labs";
--   DROP FUNCTION public.dx_dental_lab_orders_before_insert();
--   DROP FUNCTION public.dx_dental_lab_orders_guard();
--   DROP FUNCTION public.dx_dental_lab_catalog_guard();
--   DROP FUNCTION public.dx017_valid_teeth(text[]);

SET LOCAL lock_timeout = '5s';

-- Dientes de una orden: patrón FDI del odontograma (permanentes y
-- temporales), sin NULL, sin repetir y como mucho 32. Vacío vale.
CREATE FUNCTION public.dx017_valid_teeth(value text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT value IS NOT NULL
     AND pg_catalog.array_position(value, NULL) IS NULL
     AND pg_catalog.cardinality(value) <= 32
     AND pg_catalog.array_to_string(value, ',')
           ~ '^(([1-4][1-8]|[5-8][1-5])(,([1-4][1-8]|[5-8][1-5]))*)?$'
     AND (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(value) AS u(t))
           = pg_catalog.cardinality(value)
$$;

-- Guarda del catálogo (laboratorios y servicios): nunca se borran (se
-- desactivan) y no cambian de clínica, laboratorio ni fecha de alta.
-- DELETE/TRUNCATE solo un superusuario (purga administrativa y limpieza de
-- las bases de test).
CREATE FUNCTION public.dx_dental_lab_catalog_guard() RETURNS trigger
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
    RAISE EXCEPTION '%: un laboratorio o un servicio no se borra, se desactiva (DX-017)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) ->> 'tenantId') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) ->> 'tenantId')
     OR (pg_catalog.to_jsonb(NEW) ->> 'labId') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) ->> 'labId')
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION '%: la clínica, el laboratorio y la fecha de alta no cambian (DX-017)', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- dental_labs
-- ---------------------------------------------------------------------------
CREATE TABLE "dental_labs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dental_labs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dental_labs_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los mismos topes que la API (400 en español antes). IS NULL explícito:
    -- con NULL, char_length da NULL y el CHECK pasaría igual, pero así se lee.
    CONSTRAINT "dental_labs_values_check" CHECK (
      char_length(btrim("name")) BETWEEN 1 AND 120
      AND ("contactName" IS NULL OR char_length(btrim("contactName")) BETWEEN 1 AND 120)
      AND ("phone" IS NULL OR char_length(btrim("phone")) BETWEEN 1 AND 40)
      AND ("email" IS NULL OR char_length(btrim("email")) BETWEEN 3 AND 254)
      AND ("notes" IS NULL OR char_length(btrim("notes")) BETWEEN 1 AND 1000)
    )
);

-- Destino de las FK compuestas de servicios y órdenes (SEC-004).
CREATE UNIQUE INDEX "dental_labs_tenant_id_key" ON "dental_labs"("tenantId", "id");
-- Un nombre por clínica sin distinguir mayúsculas (la API responde 409 antes).
CREATE UNIQUE INDEX "dental_labs_tenant_name_key"
  ON "dental_labs"("tenantId", lower(btrim("name")));

CREATE TRIGGER "dental_labs_guard"
  BEFORE UPDATE OR DELETE ON "dental_labs"
  FOR EACH ROW EXECUTE FUNCTION public.dx_dental_lab_catalog_guard();
CREATE TRIGGER "dental_labs_no_truncate"
  BEFORE TRUNCATE ON "dental_labs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_dental_lab_catalog_guard();

ALTER TABLE "dental_labs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dental_labs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "dental_labs" FORCE ROW LEVEL SECURITY;

-- La app lee, crea y actualiza (también desactiva); nunca borra.
REVOKE DELETE, TRUNCATE ON "dental_labs" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- dental_lab_services
-- ---------------------------------------------------------------------------
CREATE TABLE "dental_lab_services" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "leadTimeBusinessDays" SMALLINT NOT NULL,
    "referencePrice" DECIMAL(12,2),
    "referenceCurrency" CHAR(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dental_lab_services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dental_lab_services_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El laboratorio es de la MISMA clínica.
    CONSTRAINT "dental_lab_services_lab_fkey"
      FOREIGN KEY ("tenantId", "labId") REFERENCES "dental_labs"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_services_currency_fkey"
      FOREIGN KEY ("referenceCurrency") REFERENCES "currencies"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_services_values_check" CHECK (
      char_length(btrim("name")) BETWEEN 1 AND 120
      AND "leadTimeBusinessDays" BETWEEN 0 AND 120
      AND ("referencePrice" IS NULL OR "referencePrice" >= 0)
      AND (("referencePrice" IS NULL) = ("referenceCurrency" IS NULL))
    )
);

-- Destino de la FK compuesta de las órdenes (servicio del MISMO laboratorio);
-- su prefijo sirve la FK al laboratorio.
CREATE UNIQUE INDEX "dental_lab_services_tenant_lab_id_key"
  ON "dental_lab_services"("tenantId", "labId", "id");
-- Un nombre por laboratorio sin distinguir mayúsculas.
CREATE UNIQUE INDEX "dental_lab_services_lab_name_key"
  ON "dental_lab_services"("tenantId", "labId", lower(btrim("name")));
-- Lado hijo de la FK a la moneda.
CREATE INDEX "dental_lab_services_currency_idx" ON "dental_lab_services"("referenceCurrency");

CREATE TRIGGER "dental_lab_services_guard"
  BEFORE UPDATE OR DELETE ON "dental_lab_services"
  FOR EACH ROW EXECUTE FUNCTION public.dx_dental_lab_catalog_guard();
CREATE TRIGGER "dental_lab_services_no_truncate"
  BEFORE TRUNCATE ON "dental_lab_services"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_dental_lab_catalog_guard();

ALTER TABLE "dental_lab_services" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dental_lab_services"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "dental_lab_services" FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON "dental_lab_services" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- dental_lab_orders
-- ---------------------------------------------------------------------------
CREATE TABLE "dental_lab_orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "professionalMembershipId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "serviceId" UUID,
    "treatmentPlanItemId" UUID,
    "appointmentId" UUID,
    "replacesOrderId" UUID,
    "description" TEXT NOT NULL,
    "toothNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "shade" TEXT,
    "material" TEXT,
    "instructions" TEXT,
    "dueOn" DATE,
    "sentAt" TIMESTAMP(3),
    "sentById" UUID,
    "receivedAt" TIMESTAMP(3),
    "receivedById" UUID,
    "checkedAt" TIMESTAMP(3),
    "checkedById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dental_lab_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dental_lab_orders_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_membership_fkey"
      FOREIGN KEY ("tenantId", "professionalMembershipId")
      REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_lab_fkey"
      FOREIGN KEY ("tenantId", "labId") REFERENCES "dental_labs"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El servicio (opcional) es del MISMO laboratorio de la MISMA clínica. Con
    -- "serviceId" NULL la FK no se comprueba (MATCH SIMPLE).
    CONSTRAINT "dental_lab_orders_service_fkey"
      FOREIGN KEY ("tenantId", "labId", "serviceId")
      REFERENCES "dental_lab_services"("tenantId", "labId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El ítem del plan y la cita de colocación, de la MISMA clínica Y del
    -- MISMO paciente (SEC-004).
    CONSTRAINT "dental_lab_orders_plan_item_fkey"
      FOREIGN KEY ("tenantId", "patientId", "treatmentPlanItemId")
      REFERENCES "treatment_plan_items"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_sent_by_fkey"
      FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_received_by_fkey"
      FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_checked_by_fkey"
      FOREIGN KEY ("checkedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dental_lab_orders_cancelled_by_fkey"
      FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los mismos topes que la API (400 en español antes).
    CONSTRAINT "dental_lab_orders_values_check" CHECK (
      "number" > 0
      AND char_length(btrim("description")) BETWEEN 1 AND 200
      AND public.dx017_valid_teeth("toothNumbers")
      AND ("shade" IS NULL OR char_length(btrim("shade")) BETWEEN 1 AND 40)
      AND ("material" IS NULL OR char_length(btrim("material")) BETWEEN 1 AND 120)
      AND ("instructions" IS NULL OR char_length(btrim("instructions")) BETWEEN 1 AND 2000)
      AND ("replacesOrderId" IS NULL OR "replacesOrderId" <> "id")
    ),
    -- Cada paso con su fecha Y su autor (o ninguno de los dos).
    CONSTRAINT "dental_lab_orders_pairs_check" CHECK (
      ("sentAt" IS NULL) = ("sentById" IS NULL)
      AND ("receivedAt" IS NULL) = ("receivedById" IS NULL)
      AND ("checkedAt" IS NULL) = ("checkedById" IS NULL)
    ),
    -- El orden de los pasos: no se recibe sin enviar ni se revisa sin recibir,
    -- y ninguna fecha es anterior a la del paso previo.
    CONSTRAINT "dental_lab_orders_steps_check" CHECK (
      ("receivedAt" IS NULL OR ("sentAt" IS NOT NULL AND "receivedAt" >= "sentAt"))
      AND ("checkedAt" IS NULL OR ("receivedAt" IS NOT NULL AND "checkedAt" >= "receivedAt"))
    ),
    -- Anulación completa (fecha, autor y motivo de 3–500) o ninguna; una
    -- revisada no se anula.
    CONSTRAINT "dental_lab_orders_cancel_check" CHECK (
      ("cancelledAt" IS NULL) = ("cancelledById" IS NULL)
      AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL)
      AND ("cancelReason" IS NULL OR char_length(btrim("cancelReason")) BETWEEN 3 AND 500)
      AND ("cancelledAt" IS NULL OR "checkedAt" IS NULL)
    )
);

-- Destino de la FK de la orden corregida (SEC-004).
CREATE UNIQUE INDEX "dental_lab_orders_tenant_id_key" ON "dental_lab_orders"("tenantId", "id");
-- La orden corregida, de la MISMA clínica (el paciente lo exige el trigger:
-- por (tenantId, id) la fusión de pacientes no la rompe). Va tras el único
-- que la sostiene; la tabla acaba de nacer vacía: la validación no lee filas.
ALTER TABLE "dental_lab_orders" ADD CONSTRAINT "dental_lab_orders_replaces_fkey"
  FOREIGN KEY ("tenantId", "replacesOrderId") REFERENCES "dental_lab_orders"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- El número es único por clínica (red bajo el candado del trigger).
CREATE UNIQUE INDEX "dental_lab_orders_tenant_number_key"
  ON "dental_lab_orders"("tenantId", "number");
-- Órdenes del paciente, más recientes primero (y lado hijo de la FK al paciente).
CREATE INDEX "dental_lab_orders_patient_created_idx"
  ON "dental_lab_orders"("tenantId", "patientId", "createdAt" DESC);
-- Trabajos pendientes de la sede («fuera»: sin recibir y sin anular) por
-- fecha prometida: la lista /laboratorio y «Solo atrasados».
CREATE INDEX "dental_lab_orders_pending_idx"
  ON "dental_lab_orders"("tenantId", "locationId", "dueOn")
  WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;
-- La lista de la sede con cualquier estado (y lado hijo de la FK a la sede).
CREATE INDEX "dental_lab_orders_location_due_idx"
  ON "dental_lab_orders"("tenantId", "locationId", "dueOn");
-- Lados hijos de las demás FK.
CREATE INDEX "dental_lab_orders_membership_idx"
  ON "dental_lab_orders"("tenantId", "professionalMembershipId");
CREATE INDEX "dental_lab_orders_lab_service_idx"
  ON "dental_lab_orders"("tenantId", "labId", "serviceId");
CREATE INDEX "dental_lab_orders_plan_item_idx"
  ON "dental_lab_orders"("tenantId", "patientId", "treatmentPlanItemId");
CREATE INDEX "dental_lab_orders_appointment_idx"
  ON "dental_lab_orders"("tenantId", "patientId", "appointmentId");
CREATE INDEX "dental_lab_orders_replaces_idx"
  ON "dental_lab_orders"("tenantId", "replacesOrderId");
CREATE INDEX "dental_lab_orders_created_by_idx" ON "dental_lab_orders"("createdById");
CREATE INDEX "dental_lab_orders_sent_by_idx" ON "dental_lab_orders"("sentById");
CREATE INDEX "dental_lab_orders_received_by_idx" ON "dental_lab_orders"("receivedById");
CREATE INDEX "dental_lab_orders_checked_by_idx" ON "dental_lab_orders"("checkedById");
CREATE INDEX "dental_lab_orders_cancelled_by_idx" ON "dental_lab_orders"("cancelledById");

-- Al insertar: número correlativo de la clínica; nace en borrador (sin
-- enviar, recibir, revisar ni anular); la orden corregida es del MISMO
-- paciente.
CREATE FUNCTION public.dx_dental_lab_orders_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."sentAt" IS NOT NULL OR NEW."sentById" IS NOT NULL
     OR NEW."receivedAt" IS NOT NULL OR NEW."receivedById" IS NOT NULL
     OR NEW."checkedAt" IS NOT NULL OR NEW."checkedById" IS NOT NULL
     OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL
     OR NEW."cancelReason" IS NOT NULL THEN
    RAISE EXCEPTION 'dental_lab_orders: una orden nace en borrador (DX-017)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."replacesOrderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."dental_lab_orders" o
     WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."replacesOrderId"
       AND o."patientId" = NEW."patientId"
  ) THEN
    RAISE EXCEPTION 'dental_lab_orders: la orden corregida es de otro paciente (DX-017)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Candado consultivo de la clínica hasta el final de la transacción: la
  -- siguiente alta espera y ve este número (READ COMMITTED: cada sentencia,
  -- foto nueva).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dental_lab_orders:' || NEW."tenantId"::text, 0));
  SELECT COALESCE(max(o."number"), 0) + 1 INTO NEW."number"
    FROM public."dental_lab_orders" o
   WHERE o."tenantId" = NEW."tenantId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "dental_lab_orders_before_insert"
  BEFORE INSERT ON "dental_lab_orders"
  FOR EACH ROW EXECUTE FUNCTION public.dx_dental_lab_orders_before_insert();

-- Guarda. «Nunca se borra, se anula»:
--   · DELETE/TRUNCATE solo un superusuario (purga y limpieza de test);
--   · una orden anulada ya no cambia;
--   · no cambian nunca la clínica, el paciente (salvo la fusión), la sede, el
--     número, el profesional, el autor ni la fecha de alta;
--   · una fecha puesta (enviada, recibida, revisada, anulada) y su autor no
--     cambian ni se quitan;
--   · tras «Enviada» el contenido no cambia: solo la fecha prometida, la cita
--     de colocación y los pasos siguientes (cualquier columna nueva queda
--     protegida sola);
--   · la orden corregida es del MISMO paciente.
CREATE FUNCTION public.dx_dental_lab_orders_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  after_sent_mutable text[] := ARRAY['dueOn', 'appointmentId', 'updatedAt',
    'receivedAt', 'receivedById', 'checkedAt', 'checkedById',
    'cancelledAt', 'cancelledById', 'cancelReason'];
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
    RAISE EXCEPTION 'dental_lab_orders: una orden de laboratorio no se borra, se anula (DX-017)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'dental_lab_orders: una orden anulada no se modifica (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."professionalMembershipId" IS DISTINCT FROM OLD."professionalMembershipId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'dental_lab_orders: la clínica, el paciente, la sede, el número, el profesional, el autor y la fecha de alta no cambian (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."sentAt" IS NOT NULL AND (NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW."sentById" IS DISTINCT FROM OLD."sentById"))
     OR (OLD."receivedAt" IS NOT NULL AND (NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" OR NEW."receivedById" IS DISTINCT FROM OLD."receivedById"))
     OR (OLD."checkedAt" IS NOT NULL AND (NEW."checkedAt" IS DISTINCT FROM OLD."checkedAt" OR NEW."checkedById" IS DISTINCT FROM OLD."checkedById")) THEN
    RAISE EXCEPTION 'dental_lab_orders: una fecha de envío, recepción o revisión no cambia ni se quita (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sentAt" IS NOT NULL
     AND (pg_catalog.to_jsonb(NEW) - after_sent_mutable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - after_sent_mutable) THEN
    RAISE EXCEPTION 'dental_lab_orders: una orden enviada no cambia; se corrige con una orden nueva que la sustituya (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."replacesOrderId" IS NOT NULL
     AND NEW."replacesOrderId" IS DISTINCT FROM OLD."replacesOrderId"
     AND NOT EXISTS (
       SELECT 1 FROM public."dental_lab_orders" o
        WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."replacesOrderId"
          AND o."patientId" = NEW."patientId"
     ) THEN
    RAISE EXCEPTION 'dental_lab_orders: la orden corregida es de otro paciente (DX-017)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "dental_lab_orders_guard"
  BEFORE UPDATE OR DELETE ON "dental_lab_orders"
  FOR EACH ROW EXECUTE FUNCTION public.dx_dental_lab_orders_guard();
CREATE TRIGGER "dental_lab_orders_no_truncate"
  BEFORE TRUNCATE ON "dental_lab_orders"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_dental_lab_orders_guard();

ALTER TABLE "dental_lab_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dental_lab_orders"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "dental_lab_orders" FORCE ROW LEVEL SECURITY;

-- La app lee, crea y actualiza (pasos y anulación); nunca borra.
REVOKE DELETE, TRUNCATE ON "dental_lab_orders" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista de 20261229190200 (DX-190) +
-- dental_lab_orders
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dx_patient_merge_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY[
    'anesthesia_administrations.patientId',
    'appointment_plan_items.patientId',
    'appointment_reserved_overrides.patientId',
    'appointment_status_reversals.patientId',
    'appointment_waitlist.patientId',
    'appointments.patientId',
    'cancellation_fees.patientId',
    'clinical_entries.patientId',
    'clinical_entry_addenda.patientId',
    'clinical_entry_diagnoses.patientId',
    'clinical_record_copies.patientId',
    'closing_queue_dismissals.patientId',
    'collection_notes.patientId',
    'data_processing_consents.patientId',
    'dental_lab_orders.patientId',
    'external_order_copy_links.patientId',
    'external_orders.patientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'opening_balances.patientId',
    'ortho_cases.patientId',
    'ortho_visits.patientId',
    'patient_agreements.patientId',
    'patient_certificate_copy_links.patientId',
    'patient_certificates.patientId',
    'patient_consent_countersignatures.patientId',
    'patient_consents.patientId',
    'patient_coverages.patientId',
    'patient_credit_entries.patientId',
    'patient_credit_refunds.patientId',
    'patient_credit_transfers.patientId',
    'patient_dentition_events.patientId',
    'patient_documents.patientId',
    'patient_implants.patientId',
    'patient_majority_reviews.patientId',
    'patient_recalls.patientId',
    'patient_responsible_parties.patientId',
    'patient_responsible_parties.responsiblePatientId',
    'patient_retention_actions.patientId',
    'payment_links.patientId',
    'payment_plans.patientId',
    'payment_promises.patientId',
    'payment_reports.patientId',
    'payments.patientId',
    'perio_exams.patientId',
    'post_op_instruction_deliveries.patientId',
    'prescription_copy_links.patientId',
    'prescriptions.patientId',
    'recall_contacts.patientId',
    'reminder_opt_out_links.patientId',
    'reminder_opt_out_match_warnings.patientId',
    'sedation_records.patientId',
    'signature_requests.patientId',
    'signed_consent_pdf_links.patientId',
    'signed_consent_pdfs.patientId',
    'tooth_records.patientId',
    'treatment_plan_acceptances.patientId',
    'treatment_plan_items.patientId',
    'treatment_plan_repricings.patientId',
    'treatment_plans.patientId',
    'waitlist_offers.patientId'
  ]::text[]
$$;
