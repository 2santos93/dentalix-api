-- DX-222: indicaciones postoperatorias.
--
-- Cambios:
--   locations."phone"   teléfono de la sede («llama a la clínica al …»),
--                      nullable, hasta 40 caracteres.
--   post_op_instruction_templates   plantillas de la clínica: código único
--                      (2–20 mayúsculas, números o guiones), título, texto
--                      con variables, versión (sube al editar el texto) y
--                      activa/inactiva.
--   post_op_instruction_template_links   cuándo sugerir cada plantilla: por
--                      un procedimiento del catálogo (puntero suave, como
--                      tooth_records: dental_catalog_items no tiene único
--                      (tenantId, id)) o por un tipo de cita (FK compuesta).
--                      Exactamente uno de los dos. Se borran con la plantilla.
--   post_op_instruction_deliveries   cada entrega al paciente por una cita:
--                      copia congelada del texto, código, título y versión,
--                      canal, quién la entregó, destinatario enmascarado, hash
--                      del token del enlace público, su caducidad y la primera
--                      apertura.
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - una entrega es INALTERABLE: solo se puede fijar "firstOpenedAt" una vez
--     (de NULL a una fecha); cualquier otro UPDATE, o un DELETE con
--     app.current_tenant fijado, se rechaza (restrict_violation). TRUNCATE
--     solo el superusuario (purga), con dx_forbid_clinical_record_mutation;
--   - "deliveredAt" y "createdAt" los pone el servidor de BD en UTC (DX-226);
--   - FK COMPUESTAS por tenant (SEC-004): paciente, cita (del MISMO paciente),
--     sede y plantilla de la misma clínica; el tipo de cita de un vínculo
--     también. Van DENTRO del CREATE TABLE (las tablas nacen vacías), así el
--     owner sin BYPASSRLS no necesita ver filas de las referenciadas (DX-134);
--   - una plantilla ya entregada no se puede borrar (RESTRICT): se desactiva.
--
-- Compatible hacia atrás: solo AÑADE (una columna nullable, tres tablas vacías,
-- índices, triggers y RLS). El código anterior no las conoce.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Teléfono de la sede. Columna nueva, todas NULL: el CHECK se valida al
--    instante (locations es pequeña).
-- ---------------------------------------------------------------------------
ALTER TABLE "locations"
  ADD COLUMN "phone" TEXT,
  ADD CONSTRAINT "locations_phone_length_check"
    CHECK ("phone" IS NULL OR char_length("phone") <= 40);

-- ---------------------------------------------------------------------------
-- 2. Plantillas
-- ---------------------------------------------------------------------------
CREATE TABLE "post_op_instruction_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_op_instruction_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_op_instruction_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismos topes que la API (código ya normalizado a mayúsculas).
    CONSTRAINT "post_op_instruction_templates_code_check"
      CHECK ("code" ~ '^[A-Z0-9-]{2,20}$'),
    CONSTRAINT "post_op_instruction_templates_lengths_check" CHECK (
      char_length(btrim("title")) BETWEEN 1 AND 200
      AND char_length(btrim("body")) BETWEEN 1 AND 20000
    ),
    CONSTRAINT "post_op_instruction_templates_version_check" CHECK ("version" >= 1)
);

-- Destino de las FK compuestas de vínculos y entregas.
CREATE UNIQUE INDEX "post_op_instruction_templates_tenant_id_key"
  ON "post_op_instruction_templates"("tenantId", "id");
CREATE UNIQUE INDEX "post_op_instruction_templates_tenant_code_key"
  ON "post_op_instruction_templates"("tenantId", "code");
-- Selector de plantillas activas.
CREATE INDEX "post_op_instruction_templates_tenant_active_idx"
  ON "post_op_instruction_templates"("tenantId", "active");

-- ---------------------------------------------------------------------------
-- 3. Vínculos plantilla ↔ procedimiento del catálogo / tipo de cita
-- ---------------------------------------------------------------------------
CREATE TABLE "post_op_instruction_template_links" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "catalogItemId" UUID,
    "appointmentTypeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_op_instruction_template_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_op_instruction_template_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: plantilla y tipo de cita de la MISMA clínica.
    CONSTRAINT "post_op_instruction_template_links_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "post_op_instruction_templates"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "post_op_instruction_template_links_appointment_type_fkey"
      FOREIGN KEY ("tenantId", "appointmentTypeId")
      REFERENCES "appointment_types"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Exactamente uno de los dos.
    CONSTRAINT "post_op_instruction_template_links_target_check"
      CHECK (("catalogItemId" IS NULL) <> ("appointmentTypeId" IS NULL))
);

-- Reemplazo de los vínculos al editar una plantilla y lado hijo de su FK.
CREATE INDEX "post_op_instruction_template_links_template_idx"
  ON "post_op_instruction_template_links"("tenantId", "templateId");
-- El mismo procedimiento o tipo de cita, una sola vez por plantilla.
CREATE UNIQUE INDEX "post_op_instruction_template_links_catalog_key"
  ON "post_op_instruction_template_links"("tenantId", "templateId", "catalogItemId")
  WHERE "catalogItemId" IS NOT NULL;
CREATE UNIQUE INDEX "post_op_instruction_template_links_type_key"
  ON "post_op_instruction_template_links"("tenantId", "templateId", "appointmentTypeId")
  WHERE "appointmentTypeId" IS NOT NULL;
-- Sugerencias para una cita (por sus procedimientos y por su tipo); el de tipo
-- es también el lado hijo de la FK a appointment_types.
CREATE INDEX "post_op_instruction_template_links_catalog_idx"
  ON "post_op_instruction_template_links"("tenantId", "catalogItemId")
  WHERE "catalogItemId" IS NOT NULL;
CREATE INDEX "post_op_instruction_template_links_type_idx"
  ON "post_op_instruction_template_links"("tenantId", "appointmentTypeId")
  WHERE "appointmentTypeId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Entregas
-- ---------------------------------------------------------------------------
CREATE TABLE "post_op_instruction_deliveries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "templateCode" TEXT NOT NULL,
    "templateTitle" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "channel" "PostOpDeliveryChannel" NOT NULL,
    "renderedText" TEXT NOT NULL,
    "deliveredById" UUID NOT NULL,
    "deliveredByName" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipientMasked" TEXT,
    "sentToResponsible" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "firstOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_op_instruction_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_op_instruction_deliveries_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: paciente, cita (del MISMO paciente), sede y plantilla de
    -- la MISMA clínica.
    CONSTRAINT "post_op_instruction_deliveries_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_instruction_deliveries_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_instruction_deliveries_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_instruction_deliveries_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "post_op_instruction_templates"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_instruction_deliveries_delivered_by_fkey"
      FOREIGN KEY ("deliveredById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Topes (defensa en profundidad ante un INSERT por SQL). El texto
    -- entregado admite más que la plantilla: las variables ya sustituidas.
    CONSTRAINT "post_op_instruction_deliveries_lengths_check" CHECK (
      "templateCode" ~ '^[A-Z0-9-]{2,20}$'
      AND char_length(btrim("templateTitle")) BETWEEN 1 AND 200
      AND "templateVersion" >= 1
      AND char_length(btrim("renderedText")) BETWEEN 1 AND 50000
      AND char_length(btrim("deliveredByName")) BETWEEN 1 AND 200
      AND ("recipientMasked" IS NULL OR char_length("recipientMasked") <= 254)
    ),
    -- Enlace público: SHA-256 en hex del token y su caducidad, juntos; la
    -- primera apertura solo existe si hay enlace.
    CONSTRAINT "post_op_instruction_deliveries_token_check" CHECK (
      ("tokenHash" IS NULL) = ("tokenExpiresAt" IS NULL)
      AND ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$')
      AND ("firstOpenedAt" IS NULL OR "tokenHash" IS NOT NULL)
    )
);

-- Búsqueda del enlace público por hash del token.
CREATE UNIQUE INDEX "post_op_instruction_deliveries_tokenHash_key"
  ON "post_op_instruction_deliveries"("tokenHash");
-- Historial de entregas del paciente (más recientes primero); también el lado
-- hijo de la FK al paciente.
CREATE INDEX "post_op_instruction_deliveries_tenant_patient_idx"
  ON "post_op_instruction_deliveries"("tenantId", "patientId", "deliveredAt" DESC);
-- Entregas de una cita.
CREATE INDEX "post_op_instruction_deliveries_tenant_appointment_idx"
  ON "post_op_instruction_deliveries"("tenantId", "appointmentId");

-- ---------------------------------------------------------------------------
-- 5. Entrega inalterable. Lista blanca al estilo de prescriptions_immutable,
--    con search_path fijo (SEC-032): solo "firstOpenedAt" de NULL a una fecha.
--    DELETE: solo sin app.current_tenant (purga administrativa / limpieza de
--    tests); la app siempre lo fija.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public."post_op_deliveries_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(pg_catalog.current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'post_op_instruction_deliveries es inalterable: una entrega registrada no se edita ni se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."firstOpenedAt" IS NOT NULL OR NEW."firstOpenedAt" IS NULL
     OR (pg_catalog.to_jsonb(NEW) - 'firstOpenedAt')
        IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'firstOpenedAt') THEN
    RAISE EXCEPTION 'post_op_instruction_deliveries es inalterable: una entrega registrada no se edita ni se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Hora de la entrega del servidor en UTC sea cual sea la zona de la sesión
-- (DX-226), igual que "createdAt" en dx_clinical_record_server_timestamp.
CREATE FUNCTION public."post_op_deliveries_server_time"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."deliveredAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "post_op_instruction_deliveries_immutable"
  BEFORE UPDATE OR DELETE ON "post_op_instruction_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public."post_op_deliveries_immutable"();
CREATE TRIGGER "post_op_instruction_deliveries_no_truncate"
  BEFORE TRUNCATE ON "post_op_instruction_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "post_op_instruction_deliveries_server_timestamp"
  BEFORE INSERT ON "post_op_instruction_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public."dx_clinical_record_server_timestamp"();
CREATE TRIGGER "post_op_instruction_deliveries_server_time"
  BEFORE INSERT ON "post_op_instruction_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public."post_op_deliveries_server_time"();

-- ---------------------------------------------------------------------------
-- 6. RLS forzada por tenant en las tres tablas.
-- ---------------------------------------------------------------------------
ALTER TABLE "post_op_instruction_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "post_op_instruction_templates"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "post_op_instruction_templates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "post_op_instruction_template_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "post_op_instruction_template_links"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "post_op_instruction_template_links" FORCE ROW LEVEL SECURITY;

ALTER TABLE "post_op_instruction_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "post_op_instruction_deliveries"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "post_op_instruction_deliveries" FORCE ROW LEVEL SECURITY;
