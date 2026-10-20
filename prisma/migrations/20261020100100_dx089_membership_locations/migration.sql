-- DX-089: personal restringido a sedes.
--
-- Cambios:
--   membership_locations   sedes a las que se restringe un miembro de la
--                          clínica (clinic_memberships). Sin filas, el miembro
--                          trabaja en todas las sedes; con filas, solo en esas.
--                          Guarda quién hizo la asignación ("createdById").
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - la misma sede una sola vez por membresía (índice único);
--   - borrar la membresía borra sus sedes (ON DELETE CASCADE): la restricción
--     no sobrevive al miembro;
--   - la sede no se borra mientras algún miembro esté restringido a ella
--     (ON DELETE RESTRICT); las sedes se retiran en blando.
--
-- FK COMPUESTAS por tenant (SEC-004): membresía y sede de la MISMA clínica.
-- Van DENTRO del CREATE TABLE (la tabla nace vacía), así el owner sin
-- BYPASSRLS no necesita ver filas de clinic_memberships ni de locations
-- (DX-134). Sus destinos son clinic_memberships_tenant_id_key (migración
-- anterior) y locations_tenant_id_key.
--
-- Compatible hacia atrás: solo AÑADE (una tabla vacía con sus FK, índices y
-- RLS). El código anterior no la conoce.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "membership_locations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_locations_pkey" PRIMARY KEY ("id"),
    -- FK COMPUESTAS: la membresía y la sede son de la MISMA clínica.
    CONSTRAINT "membership_locations_tenantId_membershipId_fkey"
      FOREIGN KEY ("tenantId", "membershipId") REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "membership_locations_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

-- La misma sede, una sola vez por membresía. Sus columnas iniciales cubren
-- también la FK de la membresía y «sedes de este miembro».
CREATE UNIQUE INDEX "membership_locations_member_location_key"
  ON "membership_locations"("tenantId", "membershipId", "locationId");
-- «Miembros restringidos a esta sede» y lado hijo de la FK de la sede.
CREATE INDEX "membership_locations_tenantId_locationId_idx"
  ON "membership_locations"("tenantId", "locationId");

ALTER TABLE "membership_locations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "membership_locations"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "membership_locations" FORCE ROW LEVEL SECURITY;
