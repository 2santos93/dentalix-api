-- DX-015-bis (D20): el tipo de cita con el que se agenda un recall de este
-- tipo. «Agendar» de la lista de recall lo prellena (D21); NULL = sin enlace
-- (una clínica nueva no trae ninguno: los tipos de cita son de cada clínica y
-- adivinarlo por nombre sería frágil).
--
--   recall_types."appointmentTypeId"  UUID NULL
--
-- FK COMPUESTA ("tenantId", "appointmentTypeId") → appointment_types
-- ("tenantId", "id") (UNIQUE `appointment_types_tenant_id_key`), como las demás
-- del repo: un tipo de recall nunca apunta a un tipo de cita de otra clínica,
-- aunque la API se equivocara. ON DELETE RESTRICT: los tipos de cita no se
-- borran, se retiran con "deletedAt"; uno retirado o desactivado después sigue
-- enlazado y la web lo ignora. Que esté vivo y activo AL ENLAZARLO lo valida la
-- API (422).
--
-- Índice ("tenantId", "appointmentTypeId") parcial: el lado hijo de la FK (sin
-- él, cualquier borrado o cambio de clave en appointment_types recorrería
-- recall_types). Tabla pequeña (unos pocos tipos por clínica): sin
-- CONCURRENTLY.
--
-- Expand puro: columna NULL sin default (PG 16 solo toca el catálogo). La FK
-- nace NOT VALID (DX-134: con FORCE en las dos tablas no se valida aquí) y se
-- valida en 20261215090100_dx015bis_recall_type_appointment_type_validate.
-- Una réplica anterior inserta sin nombrar la columna y recibe NULL. La
-- columna hereda el grant de la tabla a dentalix_app y su RLS.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "recall_types" ADD COLUMN "appointmentTypeId" UUID;

ALTER TABLE "recall_types" ADD CONSTRAINT "recall_types_appointment_type_fkey"
  FOREIGN KEY ("tenantId", "appointmentTypeId")
  REFERENCES "appointment_types"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

CREATE INDEX "recall_types_tenant_appointment_type_idx"
  ON "recall_types"("tenantId", "appointmentTypeId")
  WHERE "appointmentTypeId" IS NOT NULL;
