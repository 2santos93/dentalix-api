-- DX-560: «Descripción para el paciente» de cada ítem del catálogo, una por
-- idioma de los pacientes de la clínica. Es lo que lee el paciente en la
-- presentación del plan y en el enlace de aceptación del presupuesto en vez
-- del nombre técnico.
--
--   dental_catalog_items."patientDescription"   objeto jsonb
--                                               {idioma BCP 47 → texto}.
--                                               '{}' = sin descripción: el
--                                               paciente lee el nombre del
--                                               catálogo en su idioma.
--
-- La API valida cada entrada (idioma de la lista de la clínica, sin repetir,
-- texto de hasta 300 caracteres sin enlaces ni HTML, hasta 10 idiomas) y
-- responde 400 en español; el CHECK es la red (objeto y tamaño), como en
-- DX-564.
--
-- Expand puro: NOT NULL con DEFAULT constante solo toca el catálogo en PG 16;
-- el CHECK se valida en la misma sentencia (todas las filas = '{}';
-- `dental_catalog_items` es pequeña y no está en HOT_TABLES). Una réplica
-- anterior que inserta sin nombrar la columna recibe '{}', que es «sin
-- descripción». La columna hereda RLS y grants de la tabla.
--
-- Vuelta atrás: desplegar la API anterior y
--   ALTER TABLE "dental_catalog_items" DROP COLUMN "patientDescription";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items"
  ADD COLUMN "patientDescription" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "dental_catalog_items_patient_description_check" CHECK (
    jsonb_typeof("patientDescription") = 'object'
    AND pg_column_size("patientDescription") <= 8192
  );
