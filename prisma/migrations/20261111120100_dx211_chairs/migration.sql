-- DX-211 (porción 1): sillones (gabinetes) de cada sede como recurso de la
-- cita, con anti-solape por sillón.
--
-- Cambios (todos ADITIVOS):
--   chairs                 sillón de una sede: nombre (1–40, sin espacios en
--                          los extremos ni caracteres de control), orden de
--                          columna, profesional por defecto opcional y
--                          activo. No se borra: se desactiva (sin DELETE para
--                          dentalix_app).
--   appointments."chairId" uuid NULL: el sillón de la cita. NULL = sin
--                          sillón, que es como siguen todas las citas
--                          existentes y las de las clínicas sin sillones.
--
-- Reglas en la BD (la API responde antes con 400/404/409 en español; esto es
-- la red):
--   * Nombre ÚNICO por sede entre TODOS sus sillones, activos o no
--     (chairs_location_name_key). Decisión DX-211: las citas de un sillón
--     desactivado siguen mostrando su nombre con «(inactivo)»; dos «Sillón 1»
--     en la misma sede (uno inactivo) serían ambiguos en la agenda y en la
--     historia. Para reutilizar el nombre se reactiva el sillón.
--   * FK COMPUESTAS por tenant (SEC-004), dentro del CREATE TABLE (la tabla
--     nace vacía, DX-134):
--       - (tenantId, locationId) → locations: la sede es de la MISMA clínica;
--       - (tenantId, defaultProviderMembershipId, defaultProviderId) →
--         clinic_memberships(tenantId, id, userId): el profesional por
--         defecto es MIEMBRO de la misma clínica (el patrón de DX-050). Los
--         dos van juntos o ninguno (CHECK).
--   * appointments (tenantId, locationId, chairId) → chairs(tenantId,
--     locationId, id): el sillón es de la MISMA clínica y de la MISMA SEDE que
--     la cita. Con "chairId" NULL la FK no mira nada (MATCH SIMPLE).
--   * EXCLUDE appointments_no_overlap_per_chair: dos citas vivas y no
--     canceladas no ocupan el mismo sillón a la vez (rango medio abierto
--     [start, end), como DX-036). Incluye "tenantId" (las constraints saltan
--     la RLS) y solo mira las citas CON sillón. A diferencia del profesional,
--     un sobrecupo (DX-470) SÍ ocupa el sillón: físicamente no caben dos
--     pacientes en él.
--   * RLS FORCE por tenant en `chairs`, con NULLIF como el resto.
--
-- FK bajo FORCE (DX-134): añadir la FK de `appointments` valida leyendo la
-- hija con la RLS del owner, así que se quita FORCE a `appointments` en esta
-- misma transacción y se devuelve al final (`chairs` recibe FORCE después).
--
-- Bloqueo: ADD COLUMN sin DEFAULT es solo catálogo. La FK nueva recorre
-- `appointments` sin reescribirla (todas las filas con "chairId" NULL, no hay
-- nada que comprobar). ADD ... EXCLUDE construye un índice GiST PARCIAL
-- (WHERE "chairId" IS NOT NULL): no entra ninguna fila existente, así que el
-- ACCESS EXCLUSIVE dura lo que el recorrido de la tabla, sin inserciones en el
-- índice. lock_timeout evita quedar encolado detrás de una transacción larga.
-- El índice de la agenda por sillón va aparte, CONCURRENTLY
-- (20261111120200_dx211_appointments_chair_idx).
--
-- Compatible hacia atrás: tabla nueva y vacía y una columna NULL que el código
-- anterior no lee ni escribe (sus INSERT la dejan NULL).
--
-- Vuelta atrás (sin pérdida de citas): ALTER TABLE "appointments" DROP
-- CONSTRAINT "appointments_no_overlap_per_chair", DROP CONSTRAINT
-- "appointments_chair_fkey", DROP COLUMN "chairId"; DROP TABLE "chairs".

SET LOCAL lock_timeout = '10s';

-- btree_gist ya lo habilitó 20260731161000 (EXCLUDE de las citas).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Sillones
-- ---------------------------------------------------------------------------
CREATE TABLE "chairs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "defaultProviderId" UUID,
    "defaultProviderMembershipId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chairs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chairs_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "chairs_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: el profesional por defecto es miembro de la MISMA clínica
    -- (membresía y usuario a la vez, para que no pueda mentir sobre quién es).
    CONSTRAINT "chairs_default_provider_fkey"
      FOREIGN KEY ("tenantId", "defaultProviderMembershipId", "defaultProviderId")
      REFERENCES "clinic_memberships"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chairs_name_check" CHECK (
      "name" = btrim("name")
      AND char_length("name") BETWEEN 1 AND 40
      AND "name" !~ '[[:cntrl:]]'
    ),
    CONSTRAINT "chairs_sort_order_check" CHECK ("sortOrder" BETWEEN 0 AND 999),
    CONSTRAINT "chairs_default_provider_check" CHECK (
      ("defaultProviderId" IS NULL) = ("defaultProviderMembershipId" IS NULL)
    )
);

-- Destino de la FK compuesta de appointments (sillón de la MISMA sede).
CREATE UNIQUE INDEX "chairs_tenant_location_id_key"
  ON "chairs"("tenantId", "locationId", "id");
-- Un nombre por sede (activos o no) y lado hijo de la FK a la sede (prefijo
-- tenantId, locationId): sirve también la lista por sede.
CREATE UNIQUE INDEX "chairs_location_name_key"
  ON "chairs"("tenantId", "locationId", "name");
-- Lado hijo de la FK al profesional por defecto.
CREATE INDEX "chairs_default_provider_idx"
  ON "chairs"("tenantId", "defaultProviderMembershipId", "defaultProviderId");

ALTER TABLE "chairs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "chairs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Desactivar en lugar de borrar: la app no borra sillones.
REVOKE DELETE, TRUNCATE ON "chairs" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "chairs" TO dentalix_app;

-- ---------------------------------------------------------------------------
-- 2. El sillón de la cita
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "chairId" UUID;

-- FK compuesta con la SEDE de la cita. Bajo NO FORCE en la hija (DX-134);
-- `chairs` aún no tiene FORCE. FORCE de vuelta al final.
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_chair_fkey"
    FOREIGN KEY ("tenantId", "locationId", "chairId")
    REFERENCES "chairs"("tenantId", "locationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Anti-solape por sillón (mismo patrón que appointments_no_overlap_per_provider).
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap_per_chair"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "chairId" WITH =,
    tsrange("start", "end") WITH &&
  )
  WHERE ("chairId" IS NOT NULL AND "deletedAt" IS NULL AND "status" <> 'CANCELLED');

ALTER TABLE "chairs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;

-- Restricción EXCLUDE NO gestionada por Prisma (como las de DX-036):
-- schema.prisma no puede modelarla, así que no hay drift.
