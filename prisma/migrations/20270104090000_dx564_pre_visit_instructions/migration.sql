-- DX-564: indicaciones previas a la cita por tipo de cita («ven en ayunas»,
-- «trae tus radiografías»). Texto general de la clínica, uno por idioma de los
-- pacientes, que sale en el recordatorio por email, en la página pública de
-- confirmación y en el WhatsApp prellenado.
--
--   appointment_types."preVisitInstructions"   objeto jsonb
--                                              {idioma BCP 47 → texto}. '{}' =
--                                              sin indicaciones: nada cambia.
--
-- La API valida cada entrada (idioma de la lista de la clínica, sin repetir,
-- texto de hasta 600 caracteres sin enlaces ni HTML, hasta 10 idiomas) y
-- responde 400 en español; el CHECK es la red (objeto y tamaño), como en
-- DX-517.
--
-- Expand puro: NOT NULL con DEFAULT constante solo toca el catálogo en PG 16;
-- el CHECK se valida en la misma sentencia (todas las filas = '{}';
-- `appointment_types` es pequeña y no está en HOT_TABLES). Una réplica
-- anterior que inserta sin nombrar la columna recibe '{}', que es «sin
-- indicaciones». La columna hereda RLS y grants de la tabla.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointment_types"
  ADD COLUMN "preVisitInstructions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "appointment_types_pre_visit_instructions_check" CHECK (
    jsonb_typeof("preVisitInstructions") = 'object'
    AND pg_column_size("preVisitInstructions") <= 8192
  );
