-- DX-150: cobranza — gestiones de cobro (notas) y compromisos de pago.
--
-- Cambios:
--   collection_notes   gestión de cobro de un paciente: canal (CALL,
--                      WHATSAPP_LINK, EMAIL, IN_PERSON), resultado (NO_ANSWER,
--                      PROMISED_PAYMENT, WILL_PAY_AT_APPOINTMENT, DISPUTE,
--                      WRONG_NUMBER), texto <= 280, autor y fecha (la pone la
--                      BD). APPEND-ONLY: ni UPDATE ni DELETE (una corrección es
--                      otra nota).
--   payment_promises   compromiso de pago: importe > 0, moneda, día civil
--                      (zona de su sede), estado OPEN -> KEPT | BROKEN una
--                      sola vez (lo cierra el barrido de cobranza o el abono
--                      que lo cubre). Ni DELETE ni otro cambio. Un solo
--                      compromiso OPEN por paciente.
--   audit_events       índices parciales de COLLECTION_NOTE y PAYMENT_PROMISE
--                      (DX-102: uno por valor del enum) y el CHECK de actor
--                      admite, además, el cambio de estado de un compromiso
--                      que hace el barrido diario (sin usuario).
--
-- FK COMPUESTAS por tenant (SEC-004): paciente y sede de la MISMA clínica. Las
-- FK de las tablas nuevas van DENTRO de su CREATE TABLE (nacen vacías), así el
-- owner sin BYPASSRLS no necesita ver filas de patients/locations (DX-134).
--
-- Compatible hacia atrás: solo AÑADE (tres enums, dos tablas vacías, índices,
-- triggers, RLS) y relaja el CHECK de auditoría para un caso nuevo que el
-- código anterior no escribe.
--
-- Bloqueo: el DROP CONSTRAINT del CHECK toma ACCESS EXCLUSIVE sobre
-- audit_events y sus particiones hasta el COMMIT, y el VALIDATE las recorre:
-- mientras dure, las escrituras auditadas esperan (recorrido secuencial sin
-- reescritura, como en DX-128). lock_timeout evita quedar encolado detrás de
-- una transacción larga.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "CollectionChannel" AS ENUM ('CALL', 'WHATSAPP_LINK', 'EMAIL', 'IN_PERSON');
CREATE TYPE "CollectionOutcome" AS ENUM ('NO_ANSWER', 'PROMISED_PAYMENT', 'WILL_PAY_AT_APPOINTMENT', 'DISPUTE', 'WRONG_NUMBER');
CREATE TYPE "PaymentPromiseStatus" AS ENUM ('OPEN', 'KEPT', 'BROKEN');

-- ---------------------------------------------------------------------------
-- collection_notes
-- ---------------------------------------------------------------------------
CREATE TABLE "collection_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID,
    "channel" "CollectionChannel" NOT NULL,
    "outcome" "CollectionOutcome" NOT NULL,
    "text" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "collection_notes_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: el paciente y la sede son de la MISMA clínica.
    CONSTRAINT "collection_notes_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "collection_notes_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismo tope que la API (400 en español antes); esto es la red.
    CONSTRAINT "collection_notes_text_check"
      CHECK ("text" IS NULL OR char_length(btrim("text")) BETWEEN 1 AND 280)
);

-- Historial del paciente (ficha) y última gestión por paciente (cartera).
CREATE INDEX "collection_notes_tenant_patient_created_idx"
  ON "collection_notes"("tenantId", "patientId", "createdAt" DESC, "id" DESC);
-- Lado hijo de la FK de la sede (parcial: la vista consolidada no la lleva).
CREATE INDEX "collection_notes_tenant_location_idx"
  ON "collection_notes"("tenantId", "locationId") WHERE "locationId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- payment_promises
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_promises" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "PaymentPromiseStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "payment_promises_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_promises_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_promises_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_promises_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_promises_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_promises_amount_check" CHECK ("amount" > 0),
    -- Abierto = sin cierre; cerrado = con la hora de cierre.
    CONSTRAINT "payment_promises_settled_check"
      CHECK (("status" = 'OPEN') = ("settledAt" IS NULL))
);

-- Historial del paciente (ficha) y compromiso vigente por paciente (cartera).
CREATE INDEX "payment_promises_tenant_patient_created_idx"
  ON "payment_promises"("tenantId", "patientId", "createdAt" DESC, "id" DESC);
-- Un solo compromiso abierto por paciente; sirve también «¿tiene compromiso?»
-- (filtro hasPromise de la cartera) y el barrido de los abiertos.
CREATE UNIQUE INDEX "payment_promises_open_patient_key"
  ON "payment_promises"("tenantId", "patientId") WHERE "status" = 'OPEN';
-- Lado hijo de la FK de la sede.
CREATE INDEX "payment_promises_tenant_location_idx"
  ON "payment_promises"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- Append-only (triggers). search_path fijo con pg_temp AL FINAL y
-- pg_catalog.pg_roles calificado (SEC-032). El superusuario puede borrar
-- (limpieza de las bases de test); el owner y la app, no.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_collection_note_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- La fecha de la gestión la pone el servidor de BD.
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'collection_notes es inalterable: una gestión no se edita ni se borra; una corrección es otra nota (DX-150)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "collection_notes_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "collection_notes"
  FOR EACH ROW EXECUTE FUNCTION public.dx_collection_note_guard();
CREATE TRIGGER "collection_notes_no_truncate"
  BEFORE TRUNCATE ON "collection_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_collection_note_guard();

CREATE FUNCTION public.dx_payment_promise_guard() RETURNS trigger
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
    RAISE EXCEPTION 'payment_promises no admite %: un compromiso no se borra (DX-150)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := CURRENT_TIMESTAMP;
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'Un compromiso nace abierto (DX-150)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo OPEN -> KEPT | BROKEN, una vez, con su hora de cierre.
  IF OLD."status" <> 'OPEN' OR NEW."status" = 'OPEN'
     OR (NEW."id", NEW."tenantId", NEW."patientId", NEW."locationId", NEW."amount",
         NEW."currency", NEW."dueDate", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."patientId", OLD."locationId", OLD."amount",
         OLD."currency", OLD."dueDate", OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez (DX-150)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_promises_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_promises"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_promise_guard();
CREATE TRIGGER "payment_promises_no_truncate"
  BEFORE TRUNCATE ON "payment_promises"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_payment_promise_guard();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "collection_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_promises" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "collection_notes"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "payment_promises"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "collection_notes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_promises" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- audit_events: índices parciales por valor del enum (DX-102)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_events_resource_collection_note_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'COLLECTION_NOTE';
CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_promise_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_PROMISE';

-- ---------------------------------------------------------------------------
-- audit_events: el barrido de cobranza cierra compromisos sin usuario. Solo
-- esa escritura concreta puede ir sin actor, además del login fallido y la
-- baja del propio paciente (DX-128): UPDATE de PAYMENT_PROMISE, sin rol, con
-- el compromiso como recurso, origen JOB y motivo PROMISE_KEPT o
-- PROMISE_BROKEN. Un cierre por un abono lleva el usuario que lo registró.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    -- IS TRUE: un CHECK que da NULL PASA.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "actorRole" IS NULL
        AND "resourceId" = "patientId"
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT'
        AND "metadata" ->> 'origin' IN ('LINK', 'MESSAGE')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT_PROMISE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' IN ('PROMISE_KEPT', 'PROMISE_BROKEN')) IS TRUE
  ) NOT VALID;
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
