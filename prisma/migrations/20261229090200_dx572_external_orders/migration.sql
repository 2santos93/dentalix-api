-- DX-572: órdenes de estudios (imagen, laboratorio clínico) y referencias a
-- especialistas externos. Un solo formato para todas las clínicas: nada
-- depende del país.
--
-- Cambios:
--   tenants."externalOrderOverdueDays"  días tras los que una orden sin
--                     resultado sale «vencida» (1..365, 15 de plataforma).
--                     CHECK NOT VALID; VALIDATE en 20261229090400.
--   external_order_templates  plantillas de la clínica: nombre (1–80, único
--                     por clínica), tipo, destinatario habitual opcional
--                     (1–120), 1 a 20 estudios de 1–200, activa y versión
--                     optimista. No se borran (sin DELETE para la app).
--   external_orders   una orden por fila. FK compuestas por clínica a
--                     paciente, cita opcional (del MISMO paciente; el trigger
--                     exige la MISMA sede), sede, membresía del profesional,
--                     plantilla y los tres documentos (PDF archivado, PDF
--                     anulado y resultado). Foto inalterable (`snapshot`) y
--                     clave del logo congelada (`clinicLogoKey`, CHECK de
--                     DX-019-bis). Número correlativo por sede que pone el
--                     trigger bajo un candado consultivo de la sede. El trigger
--                     de guarda solo admite enlazar el PDF una vez, anular
--                     (ISSUED → VOIDED, con su PDF anulado una vez) y ligar o
--                     desligar el resultado (ISSUED ↔ RESULT_RECEIVED); no se
--                     borra. Abre la puerta de la fusión de pacientes (DX-266).
--   external_order_copy_links  enlace de UN SOLO USO de la copia para el
--                     paciente: solo el sha256 del token, canal, a quién
--                     (enmascarado), caducidad, cuándo se gastó y cuándo se
--                     invalidó. Como mucho uno vivo por orden (único parcial).
--   dx572_valid_lines(text[], int, int)  la forma de las listas de estudios
--                     (sin NULL, 1..N elementos de 1..M caracteres), para los
--                     CHECK.
--   dx_patient_merge_tables()  CREATE OR REPLACE con las dos columnas de
--                     paciente nuevas (lista cerrada de DX-266).
--
-- FK sobre tablas con RLS FORCE (DX-134): las de las tablas nuevas van DENTRO
-- de los CREATE TABLE (nacen vacías: no hay nada que validar). FK directa a
-- tenants con RESTRICT. RLS ENABLE + FORCE con la política NULLIF (DX-251).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas;
-- a las tres se les quitan DELETE y TRUNCATE.
--
-- Compatible hacia atrás: tablas nuevas, una columna con DEFAULT constante
-- (sin reescritura) que el código anterior no lee y una función de catálogo
-- que solo AÑADE entradas. lock_timeout evita quedar encolado tras una
-- transacción larga.

SET LOCAL lock_timeout = '5s';

-- Ajuste de la clínica --------------------------------------------------------

ALTER TABLE "tenants"
  ADD COLUMN "externalOrderOverdueDays" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_external_order_overdue_days_check"
  CHECK ("externalOrderOverdueDays" BETWEEN 1 AND 365) NOT VALID;

-- Tipos -----------------------------------------------------------------------

CREATE TYPE "ExternalOrderKind" AS ENUM ('IMAGING', 'LAB', 'SPECIALIST', 'OTHER');
CREATE TYPE "ExternalOrderStatus" AS ENUM ('ISSUED', 'RESULT_RECEIVED', 'VOIDED');

-- Forma de una lista de líneas de texto: sin NULL, de 1 a p_max_items
-- elementos, cada uno de 1 a p_max_len caracteres sin contar los espacios de
-- los bordes.
CREATE FUNCTION public.dx572_valid_lines(value text[], p_max_items integer, p_max_len integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT value IS NOT NULL
     AND pg_catalog.cardinality(value) BETWEEN 1 AND p_max_items
     AND pg_catalog.array_position(value, NULL) IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.unnest(value) AS v(line)
        WHERE pg_catalog.char_length(pg_catalog.btrim(v.line)) NOT BETWEEN 1 AND p_max_len
     )
$$;

-- ---------------------------------------------------------------------------
-- external_order_templates
-- ---------------------------------------------------------------------------
CREATE TABLE "external_order_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ExternalOrderKind" NOT NULL,
    "recipient" TEXT,
    "items" TEXT[] NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_order_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_order_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_order_templates_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "external_order_templates_recipient_check"
      CHECK ("recipient" IS NULL OR char_length(btrim("recipient")) BETWEEN 1 AND 120),
    CONSTRAINT "external_order_templates_items_check"
      CHECK (public.dx572_valid_lines("items", 20, 200)),
    CONSTRAINT "external_order_templates_version_check" CHECK ("version" >= 1)
);

-- Destino de la FK compuesta de las órdenes (SEC-004).
CREATE UNIQUE INDEX "external_order_templates_tenant_id_key"
  ON "external_order_templates"("tenantId", "id");
CREATE UNIQUE INDEX "external_order_templates_tenant_name_key"
  ON "external_order_templates"("tenantId", "name");

-- ---------------------------------------------------------------------------
-- external_orders
-- ---------------------------------------------------------------------------
CREATE TABLE "external_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "appointmentId" UUID,
    "professionalMembershipId" UUID NOT NULL,
    "issuedById" UUID NOT NULL,
    "kind" "ExternalOrderKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'ISSUED',
    "recipient" TEXT NOT NULL,
    "items" TEXT[] NOT NULL,
    "toothNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "clinicalNote" TEXT,
    "templateId" UUID,
    "snapshot" JSONB NOT NULL,
    "clinicLogoKey" TEXT,
    "documentId" UUID,
    "resultDocumentId" UUID,
    "resultLinkedAt" TIMESTAMP(3),
    "resultLinkedById" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "voidedDocumentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_orders_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La cita (opcional) es del MISMO paciente y de la MISMA clínica. Con
    -- "appointmentId" NULL la FK no se comprueba (MATCH SIMPLE).
    CONSTRAINT "external_orders_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_location_fkey"
      FOREIGN KEY ("tenantId", "locationId")
      REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_membership_fkey"
      FOREIGN KEY ("tenantId", "professionalMembershipId")
      REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "external_order_templates"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_issued_by_fkey"
      FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_voided_by_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_result_linked_by_fkey"
      FOREIGN KEY ("resultLinkedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_document_fkey"
      FOREIGN KEY ("tenantId", "documentId")
      REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_voided_document_fkey"
      FOREIGN KEY ("tenantId", "voidedDocumentId")
      REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_result_document_fkey"
      FOREIGN KEY ("tenantId", "resultDocumentId")
      REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_orders_number_check" CHECK ("number" > 0),
    CONSTRAINT "external_orders_recipient_check"
      CHECK (char_length(btrim("recipient")) BETWEEN 1 AND 120),
    CONSTRAINT "external_orders_items_check"
      CHECK (public.dx572_valid_lines("items", 20, 200)),
    -- Cada diente con el patrón FDI del odontograma (permanentes y
    -- temporales), sin NULL y como mucho 32. Vacío: '' encaja con el ?.
    CONSTRAINT "external_orders_teeth_check"
      CHECK (
        pg_catalog.array_position("toothNumbers", NULL) IS NULL
        AND pg_catalog.cardinality("toothNumbers") <= 32
        AND pg_catalog.array_to_string("toothNumbers", ',')
              ~ '^(([1-4][1-8]|[5-8][1-5])(,([1-4][1-8]|[5-8][1-5]))*)?$'
      ),
    CONSTRAINT "external_orders_clinical_note_check"
      CHECK ("clinicalNote" IS NULL OR char_length(btrim("clinicalNote")) BETWEEN 1 AND 1000),
    CONSTRAINT "external_orders_snapshot_check"
      CHECK (jsonb_typeof("snapshot") = 'object'),
    -- DX-019-bis: lo que clinicLogoPublicUrl sabe pintar (y
    -- clinicLogoKeyToFreeze congela). Tabla nueva y vacía: el CHECK nace
    -- válido dentro del CREATE TABLE, sin NOT VALID ni VALIDATE aparte.
    CONSTRAINT "external_orders_clinic_logo_key_check" CHECK (
      "clinicLogoKey" IS NULL
      OR (
        "clinicLogoKey" ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
        AND strpos("clinicLogoKey", '..') = 0
      )
      OR "clinicLogoKey" ~* '^https?://'
    ),
    -- Anulación: VOIDED <=> las tres juntas; el PDF anulado, solo anulada.
    CONSTRAINT "external_orders_void_check"
      CHECK (
        (("status" = 'VOIDED') = ("voidedAt" IS NOT NULL))
        AND (("voidedAt" IS NULL) = ("voidedById" IS NULL))
        AND (("voidedAt" IS NULL) = ("voidReason" IS NULL))
        AND ("voidReason" IS NULL OR char_length(btrim("voidReason")) BETWEEN 5 AND 500)
        AND ("voidedDocumentId" IS NULL OR "voidedAt" IS NOT NULL)
      ),
    -- Resultado: RESULT_RECEIVED <=> documento, fecha y autor.
    CONSTRAINT "external_orders_result_check"
      CHECK (
        (("status" = 'RESULT_RECEIVED') = ("resultDocumentId" IS NOT NULL))
        AND (("resultDocumentId" IS NULL) = ("resultLinkedAt" IS NULL))
        AND (("resultDocumentId" IS NULL) = ("resultLinkedById" IS NULL))
      )
);

-- El número es único por sede (red bajo el candado del trigger).
CREATE UNIQUE INDEX "external_orders_location_number_key"
  ON "external_orders"("tenantId", "locationId", "number");
-- Destino de la FK compuesta de los enlaces de la copia (SEC-004).
CREATE UNIQUE INDEX "external_orders_tenant_id_key"
  ON "external_orders"("tenantId", "id");
-- Lista de la ficha, más reciente primero (y lado hijo de la FK al paciente).
CREATE INDEX "external_orders_patient_idx"
  ON "external_orders"("tenantId", "patientId", "issuedAt" DESC);
-- «Órdenes sin resultado» de una sede, la más antigua primero.
CREATE INDEX "external_orders_pending_idx"
  ON "external_orders"("tenantId", "locationId", "status", "issuedAt");
-- Sugerencias de destinatario de los últimos 12 meses.
CREATE INDEX "external_orders_issued_idx"
  ON "external_orders"("tenantId", "issuedAt");
-- Lados hijos de las demás FK.
CREATE INDEX "external_orders_appointment_idx"
  ON "external_orders"("tenantId", "patientId", "appointmentId");
CREATE INDEX "external_orders_membership_idx"
  ON "external_orders"("tenantId", "professionalMembershipId");
CREATE INDEX "external_orders_template_idx"
  ON "external_orders"("tenantId", "templateId");
CREATE INDEX "external_orders_issued_by_idx"
  ON "external_orders"("issuedById");
CREATE INDEX "external_orders_voided_by_idx"
  ON "external_orders"("voidedById");
CREATE INDEX "external_orders_result_linked_by_idx"
  ON "external_orders"("resultLinkedById");
CREATE INDEX "external_orders_document_idx"
  ON "external_orders"("tenantId", "documentId");
CREATE INDEX "external_orders_voided_document_idx"
  ON "external_orders"("tenantId", "voidedDocumentId");
CREATE INDEX "external_orders_result_document_idx"
  ON "external_orders"("tenantId", "resultDocumentId");

-- Al insertar: número correlativo de la sede, hora del servidor; nace
-- emitida, sin anular, sin resultado y sin PDF; la cita, si la hay, es de la
-- sede de la orden.
CREATE FUNCTION public."external_orders_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  appointment_location UUID;
BEGIN
  IF NEW."appointmentId" IS NOT NULL THEN
    SELECT a."locationId" INTO appointment_location
      FROM public."appointments" a
     WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
    IF appointment_location IS DISTINCT FROM NEW."locationId" THEN
      RAISE EXCEPTION 'external_orders: la sede no es la de la cita (DX-572)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" IS DISTINCT FROM 'ISSUED'
     OR NEW."voidedAt" IS NOT NULL OR NEW."voidedById" IS NOT NULL
     OR NEW."voidReason" IS NOT NULL OR NEW."voidedDocumentId" IS NOT NULL
     OR NEW."resultDocumentId" IS NOT NULL OR NEW."resultLinkedAt" IS NOT NULL
     OR NEW."resultLinkedById" IS NOT NULL
     OR NEW."documentId" IS NOT NULL THEN
    RAISE EXCEPTION 'external_orders: nace emitida, sin anular, sin resultado y sin PDF (DX-572)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Candado consultivo de la sede hasta el final de la transacción: la
  -- siguiente emisión de la misma sede espera y ve este número (READ
  -- COMMITTED: cada sentencia, foto nueva).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'external_orders:' || NEW."tenantId"::text || ':' || NEW."locationId"::text, 0));
  SELECT COALESCE(max(o."number"), 0) + 1 INTO NEW."number"
    FROM public."external_orders" o
   WHERE o."tenantId" = NEW."tenantId" AND o."locationId" = NEW."locationId";
  NEW."issuedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  NEW."createdAt" := NEW."issuedAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "external_orders_before_insert"
  BEFORE INSERT ON "external_orders"
  FOR EACH ROW EXECUTE FUNCTION public."external_orders_before_insert"();

-- Inmutable: el contenido (todo salvo las columnas de abajo) no cambia nunca;
-- cualquier columna nueva queda protegida sola. Solo se admite:
--   · enlazar el PDF archivado una vez (documentId de NULL a un valor);
--   · ISSUED → VOIDED, con los tres campos de la anulación, y enlazar después
--     el PDF anulado una vez (voidedDocumentId de NULL a un valor);
--   · ISSUED → RESULT_RECEIVED, con los tres campos del resultado;
--   · RESULT_RECEIVED → ISSUED (desligar), que los vacía.
-- No se borra.
CREATE FUNCTION public."external_orders_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mutable_cols text[] := ARRAY['status', 'documentId', 'resultDocumentId',
    'resultLinkedAt', 'resultLinkedById', 'voidedAt', 'voidedById',
    'voidReason', 'voidedDocumentId'];
  void_changed boolean;
  result_changed boolean;
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
    RAISE EXCEPTION 'external_orders: una orden no se borra, se anula (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'external_orders: el contenido de una orden emitida no cambia (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."documentId" IS NOT NULL
     AND NEW."documentId" IS DISTINCT FROM OLD."documentId" THEN
    RAISE EXCEPTION 'external_orders: el PDF archivado no cambia (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedDocumentId" IS NOT NULL
     AND NEW."voidedDocumentId" IS DISTINCT FROM OLD."voidedDocumentId" THEN
    RAISE EXCEPTION 'external_orders: el PDF anulado no cambia (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  void_changed := NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
    OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
    OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason";
  result_changed := NEW."resultDocumentId" IS DISTINCT FROM OLD."resultDocumentId"
    OR NEW."resultLinkedAt" IS DISTINCT FROM OLD."resultLinkedAt"
    OR NEW."resultLinkedById" IS DISTINCT FROM OLD."resultLinkedById";
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'ISSUED' AND NEW."status" = 'VOIDED' THEN
      IF result_changed THEN
        RAISE EXCEPTION 'external_orders: anular no toca el resultado (DX-572)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF OLD."status" = 'ISSUED' AND NEW."status" = 'RESULT_RECEIVED' THEN
      IF void_changed OR NEW."voidedDocumentId" IS DISTINCT FROM OLD."voidedDocumentId" THEN
        RAISE EXCEPTION 'external_orders: ligar el resultado no toca la anulación (DX-572)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF OLD."status" = 'RESULT_RECEIVED' AND NEW."status" = 'ISSUED' THEN
      IF void_changed OR NEW."voidedDocumentId" IS DISTINCT FROM OLD."voidedDocumentId" THEN
        RAISE EXCEPTION 'external_orders: desligar el resultado no toca la anulación (DX-572)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION 'external_orders: transición de % a % no admitida (DX-572)', OLD."status", NEW."status"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF void_changed OR result_changed THEN
      RAISE EXCEPTION 'external_orders: la anulación y el resultado solo cambian con el estado (DX-572)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "external_orders_guard"
  BEFORE UPDATE OR DELETE ON "external_orders"
  FOR EACH ROW EXECUTE FUNCTION public."external_orders_guard"();
CREATE TRIGGER "external_orders_no_truncate"
  BEFORE TRUNCATE ON "external_orders"
  FOR EACH STATEMENT EXECUTE FUNCTION public."external_orders_guard"();

-- ---------------------------------------------------------------------------
-- external_order_copy_links
-- ---------------------------------------------------------------------------
CREATE TABLE "external_order_copy_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "external_order_copy_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_order_copy_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La orden y el paciente de la MISMA clínica.
    CONSTRAINT "external_order_copy_links_order_fkey"
      FOREIGN KEY ("tenantId", "orderId")
      REFERENCES "external_orders"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_order_copy_links_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_order_copy_links_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "external_order_copy_links_channel_check"
      CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
    CONSTRAINT "external_order_copy_links_destination_check"
      CHECK (char_length("destinationMasked") BETWEEN 1 AND 320),
    -- sha256 en hex: nunca el token en claro.
    CONSTRAINT "external_order_copy_links_token_hash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "external_order_copy_links_expiry_check"
      CHECK ("expiresAt" > "createdAt"),
    -- Usado o invalidado, nunca las dos cosas.
    CONSTRAINT "external_order_copy_links_state_check"
      CHECK ("usedAt" IS NULL OR "revokedAt" IS NULL)
);

CREATE UNIQUE INDEX "external_order_copy_links_token_hash_key"
  ON "external_order_copy_links"("tokenHash");
-- Como mucho UN enlace vivo (sin usar ni invalidar) por orden.
CREATE UNIQUE INDEX "external_order_copy_links_live_key"
  ON "external_order_copy_links"("tenantId", "orderId")
  WHERE "revokedAt" IS NULL AND "usedAt" IS NULL;
-- Los vivos de un paciente: archivar los cuenta y los invalida (DX-461).
CREATE INDEX "external_order_copy_links_patient_live_idx"
  ON "external_order_copy_links"("tenantId", "patientId")
  WHERE "revokedAt" IS NULL AND "usedAt" IS NULL;
-- El último envío de una orden (y lado hijo de la FK a la orden).
CREATE INDEX "external_order_copy_links_sent_idx"
  ON "external_order_copy_links"("tenantId", "orderId", "createdAt");
-- Lado hijo de la FK al paciente.
CREATE INDEX "external_order_copy_links_patient_idx"
  ON "external_order_copy_links"("tenantId", "patientId");
CREATE INDEX "external_order_copy_links_created_by_idx"
  ON "external_order_copy_links"("createdById");

-- Un enlace cambia UNA vez: se gasta (usedAt) o se invalida (revokedAt). Nada
-- más cambia y no se borra.
CREATE FUNCTION public."external_order_copy_links_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'external_order_copy_links: no se borra un enlace de la copia de la orden (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'external_order_copy_links: un enlace usado o invalidado no cambia (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['usedAt', 'revokedAt'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['usedAt', 'revokedAt']) THEN
    RAISE EXCEPTION 'external_order_copy_links: solo se marca usado o invalidado (DX-572)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "external_order_copy_links_guard"
  BEFORE UPDATE OR DELETE ON "external_order_copy_links"
  FOR EACH ROW EXECUTE FUNCTION public."external_order_copy_links_guard"();
CREATE TRIGGER "external_order_copy_links_no_truncate"
  BEFORE TRUNCATE ON "external_order_copy_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public."external_order_copy_links_guard"();

-- ---------------------------------------------------------------------------
-- RLS y grants
-- ---------------------------------------------------------------------------
ALTER TABLE "external_order_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "external_order_templates"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "external_order_templates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "external_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "external_orders"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "external_orders" FORCE ROW LEVEL SECURITY;

ALTER TABLE "external_order_copy_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "external_order_copy_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "external_order_copy_links" FORCE ROW LEVEL SECURITY;

-- La plantilla se desactiva; la orden se anula; el enlace se gasta o se
-- invalida: ninguna se borra.
REVOKE DELETE, TRUNCATE ON "external_order_templates" FROM dentalix_app;
REVOKE DELETE, TRUNCATE ON "external_orders" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "external_orders" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "external_order_copy_links" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "external_order_copy_links" TO dentalix_app;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista CERRADA con las dos columnas nuevas
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
    'external_order_copy_links.patientId',
    'external_orders.patientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'opening_balances.patientId',
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
