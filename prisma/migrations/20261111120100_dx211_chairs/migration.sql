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
--   * Nombre ÚNICO por sede entre TODOS sus sillones, activos o no, SIN
--     distinguir mayúsculas (chairs_location_name_key, sobre lower(name)):
--     «Sillón 1» y «sillón 1» son el mismo. Decisión DX-211: las citas de un sillón
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
--     la cita. Con "chairId" NULL la FK no mira nada (MATCH SIMPLE). Se crea
--     NOT VALID (solo catálogo: no recorre `appointments` con el ACCESS
--     EXCLUSIVE de esta migración) y se valida en
--     20261111120150_dx211_appointments_chair_fk_validate, que solo toma
--     SHARE UPDATE EXCLUSIVE. Las filas nuevas ya se comprueban desde aquí.
--   * EXCLUDE appointments_no_overlap_per_chair: dos citas vivas y no
--     canceladas no ocupan el mismo sillón a la vez (rango medio abierto
--     [start, end), como DX-036). Incluye "tenantId" (las constraints saltan
--     la RLS) y solo mira las citas CON sillón. A diferencia del profesional,
--     un sobrecupo (DX-470) SÍ ocupa el sillón: físicamente no caben dos
--     pacientes en él.
--   * RLS FORCE por tenant en `chairs`, con NULLIF como el resto.
--
-- FK bajo FORCE (DX-134): la FK se añade NOT VALID (no valida filas aquí) y
-- su VALIDATE va en la migración siguiente con NO FORCE/FORCE de la hija y
-- la referenciada, como exige la regla.
--
-- Bloqueo: ADD COLUMN sin DEFAULT y la FK NOT VALID son solo catálogo.
-- ADD ... EXCLUDE construye un índice GiST PARCIAL (WHERE "chairId" IS NOT
-- NULL) con ACCESS EXCLUSIVE sobre `appointments`: recorre la tabla una vez
-- pero no entra ninguna fila (todas tienen "chairId" NULL). Medido en local
-- (Postgres 16) con 60 000 citas: ~20 ms (ver «Coste medido» abajo), el
-- mismo orden que el patrón aceptado en DX-036/DX-470 para estas EXCLUDE.
-- lock_timeout evita quedar encolado detrás de una transacción larga.
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
-- Un nombre por sede (activos o no), sin distinguir mayúsculas. Es también
-- el lado hijo de la FK a la sede (prefijo tenantId, locationId) y sirve la
-- lista por sede. Índice de expresión: schema.prisma no lo declara.
CREATE UNIQUE INDEX "chairs_location_name_key"
  ON "chairs"("tenantId", "locationId", lower("name"));
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

-- FK compuesta con la SEDE de la cita, NOT VALID: solo catálogo. La valida
-- 20261111120150_dx211_appointments_chair_fk_validate.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_chair_fkey"
    FOREIGN KEY ("tenantId", "locationId", "chairId")
    REFERENCES "chairs"("tenantId", "locationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

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

-- Restricción EXCLUDE NO gestionada por Prisma (como las de DX-036):
-- schema.prisma no puede modelarla, así que no hay drift.

-- Coste medido (DX-211, revisión M1): en una base local de Postgres 16 con
-- 60 000 citas vivas de una clínica, `ADD CONSTRAINT
-- appointments_no_overlap_per_chair` tardó ~20 ms y el VALIDATE de
-- la FK (migración siguiente) ~1 ms. La EXCLUDE no se puede crear
-- CONCURRENTLY; con la tabla de una clínica de tamaño modesto el bloqueo es
-- de milisegundos, como el de DX-036/DX-470.

