-- DX-559: plantillas de plan de tratamiento.
--
-- Cambios:
--   treatment_plan_templates       cabecera: nombre (1–80, único por clínica),
--                                  activa, versión optimista e intervalos
--                                  entre visitas (misma forma que
--                                  treatment_plans."visitIntervals", claves 2
--                                  a 50 y días 0 a 3650). Sin precios ni
--                                  descuentos. No se borra: sin DELETE para
--                                  la app (se desactiva).
--   treatment_plan_template_lines  1 a 50 líneas por plantilla: procedimiento
--                                  del catálogo (FK compuesta, RESTRICT),
--                                  cantidad 1–20, visita 1–50, etiqueta de
--                                  visita opcional (≤60) y si pide
--                                  superficies. Se reemplazan enteras al
--                                  editar y se van con la plantilla
--                                  (CASCADE).
--   dx559_valid_template_intervals la forma de los intervalos, para el CHECK.
--
-- Las dos tablas llevan FK directa a tenants (RESTRICT, DX-148), único
-- (tenantId, id) y RLS ENABLE + FORCE con NULLIF.
--
-- FK sobre tablas con RLS FORCE (DX-134): las FK van DENTRO de los CREATE
-- TABLE, con las tablas hijas vacías; no hay nada que validar.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas;
-- a la cabecera se le quitan DELETE y TRUNCATE.
--
-- Compatible hacia atrás: solo AÑADE (dos tablas, una función, índices y
-- RLS) que el código anterior no lee.

SET LOCAL lock_timeout = '5s';

-- Forma de los intervalos: objeto con claves "2".."50" y días enteros 0..3650.
CREATE FUNCTION public.dx559_valid_template_intervals(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'object' THEN false ELSE NOT EXISTS (
    SELECT 1 FROM jsonb_each(value) e
     WHERE e.key !~ '^[1-9][0-9]?$'
        OR CASE WHEN e.key ~ '^[1-9][0-9]?$'
                THEN e.key::integer NOT BETWEEN 2 AND 50 ELSE true END
        OR CASE WHEN jsonb_typeof(e.value) = 'number'
                THEN (e.value::text)::numeric NOT BETWEEN 0 AND 3650
                  OR trunc((e.value::text)::numeric) <> (e.value::text)::numeric
                ELSE true END
  ) END
$$;

-- ---------------------------------------------------------------------------
-- treatment_plan_templates
-- ---------------------------------------------------------------------------
CREATE TABLE "treatment_plan_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "visitIntervals" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treatment_plan_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "treatment_plan_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_templates_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "treatment_plan_templates_version_check" CHECK ("version" >= 1),
    CONSTRAINT "treatment_plan_templates_visit_intervals_check"
      CHECK (public.dx559_valid_template_intervals("visitIntervals"))
);

-- Destino de la FK compuesta de las líneas (SEC-004).
CREATE UNIQUE INDEX "treatment_plan_templates_tenant_id_key"
  ON "treatment_plan_templates"("tenantId", "id");
CREATE UNIQUE INDEX "treatment_plan_templates_tenant_name_key"
  ON "treatment_plan_templates"("tenantId", "name");

-- ---------------------------------------------------------------------------
-- treatment_plan_template_lines
-- ---------------------------------------------------------------------------
CREATE TABLE "treatment_plan_template_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "visit" INTEGER NOT NULL DEFAULT 1,
    "visitLabel" VARCHAR(60),
    "asksSurfaces" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treatment_plan_template_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "treatment_plan_template_lines_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La plantilla, de la MISMA clínica; las líneas se van con ella.
    CONSTRAINT "treatment_plan_template_lines_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "treatment_plan_templates"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    -- El procedimiento, de la MISMA clínica (el catálogo se retira en blando).
    CONSTRAINT "treatment_plan_template_lines_catalog_fkey"
      FOREIGN KEY ("tenantId", "catalogItemId")
      REFERENCES "dental_catalog_items"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_template_lines_position_check"
      CHECK ("position" BETWEEN 0 AND 49),
    CONSTRAINT "treatment_plan_template_lines_quantity_check"
      CHECK ("quantity" BETWEEN 1 AND 20),
    CONSTRAINT "treatment_plan_template_lines_visit_check"
      CHECK ("visit" BETWEEN 1 AND 50),
    CONSTRAINT "treatment_plan_template_lines_visit_label_check"
      CHECK ("visitLabel" IS NULL OR char_length(btrim("visitLabel")) BETWEEN 1 AND 60)
);

CREATE UNIQUE INDEX "treatment_plan_template_lines_tenant_id_key"
  ON "treatment_plan_template_lines"("tenantId", "id");
-- Orden único por plantilla (y lado hijo de la FK a la plantilla).
CREATE UNIQUE INDEX "treatment_plan_template_lines_position_key"
  ON "treatment_plan_template_lines"("tenantId", "templateId", "position");
-- Lado hijo de la FK al catálogo.
CREATE INDEX "treatment_plan_template_lines_catalog_idx"
  ON "treatment_plan_template_lines"("tenantId", "catalogItemId");

-- ---------------------------------------------------------------------------
-- RLS y grants
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "treatment_plan_templates"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "treatment_plan_templates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "treatment_plan_template_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "treatment_plan_template_lines"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "treatment_plan_template_lines" FORCE ROW LEVEL SECURITY;

-- La plantilla no se borra: se desactiva. Las líneas sí se reemplazan.
REVOKE DELETE, TRUNCATE ON "treatment_plan_templates" FROM dentalix_app;
