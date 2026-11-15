-- DX-090: permisos extra por membresía (catálogo cerrado de dos).
--
-- Aditiva: un tipo nuevo y una columna con DEFAULT '{}' (NOT NULL). En
-- Postgres 11+ añadir una columna con DEFAULT constante no reescribe la tabla.
-- Las membresías existentes quedan sin permisos extra: su acceso no cambia.
--
-- RLS: clinic_memberships ya tiene su política por tenant; la columna nueva
-- la hereda (las políticas son por fila, no por columna). No hace falta
-- política nueva.

CREATE TYPE "ExtraPermission" AS ENUM ('PAYMENT_REGISTER', 'FINANCIAL_REPORTS_VIEW');

ALTER TABLE "clinic_memberships"
  ADD COLUMN "extraPermissions" "ExtraPermission"[] NOT NULL DEFAULT ARRAY[]::"ExtraPermission"[];

-- Sin duplicados en el array: el caso de uso ya los quita y esta es la
-- frontera de la BD. Un CHECK no admite subconsultas, de ahí la función
-- inmutable.
CREATE FUNCTION public."dx_extra_permissions_distinct"(p "ExtraPermission"[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$ SELECT cardinality(p) = (SELECT count(DISTINCT x) FROM unnest(p) AS x) $$;

ALTER TABLE "clinic_memberships"
  ADD CONSTRAINT "clinic_memberships_extra_permissions_distinct"
  CHECK (public."dx_extra_permissions_distinct"("extraPermissions"));
