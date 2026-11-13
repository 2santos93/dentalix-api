-- DX-497: idioma preferido del paciente y recordatorio por email en ese
-- idioma. Expand puro (aditivo):
--   - tenants."patientLanguages": lista de etiquetas BCP 47 que el ADMIN
--     ofrece en la ficha (Ajustes › Idiomas de los pacientes). Nace con
--     ARRAY['es'] (el idioma de la clínica). En PG 16, ADD COLUMN con DEFAULT
--     constante y NOT NULL solo toca el catálogo; el CHECK se valida en la
--     misma sentencia (`tenants` tiene una fila por clínica, como DX-328).
--   - patients."preferredLanguage": NULL = «Idioma de la clínica». No es un
--     dato clínico. CHECK de formato NOT VALID (su VALIDATE va en
--     20261217090100, otra transacción): `patients` es grande.
--   - outbound_messages."language" / "languageFallbackFrom": en qué idioma
--     salió el mensaje y, si el del paciente no tenía traducción, cuál pidió
--     («sin traducción: ca → es»). NULL en los mensajes anteriores.
--
-- Formato admitido (subconjunto canónico de BCP 47 que escribe la API):
-- idioma (2–3 minúsculas), escritura opcional (4 letras, la primera
-- mayúscula) y región opcional (2 mayúsculas o 3 dígitos): `es`, `en`,
-- `ca`, `pt-BR`, `zh-Hant-TW`, `es-419`.
--
-- Quitar un idioma de la lista NO toca a los pacientes que lo tenían: su
-- ficha lo enseña como «(no disponible) ca» y el email sale en el idioma de
-- la clínica.
--
-- Grants: no aplica (columnas nuevas de tablas ya concedidas a dentalix_app).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "patientLanguages" TEXT[] NOT NULL DEFAULT ARRAY['es']::TEXT[],
  ADD CONSTRAINT "tenants_patient_languages_check"
    CHECK (
      cardinality("patientLanguages") BETWEEN 1 AND 20
      AND array_position("patientLanguages", NULL) IS NULL
      AND array_to_string("patientLanguages", ' ') ~
        '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?( [a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?)*$'
    );

ALTER TABLE "patients"
  ADD COLUMN "preferredLanguage" TEXT,
  ADD CONSTRAINT "patients_preferred_language_check"
    CHECK (
      "preferredLanguage" IS NULL
      OR "preferredLanguage" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'
    ) NOT VALID;

ALTER TABLE "outbound_messages"
  ADD COLUMN "language" TEXT,
  ADD COLUMN "languageFallbackFrom" TEXT,
  ADD CONSTRAINT "outbound_messages_language_check"
    CHECK (
      ("language" IS NULL
        OR "language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
      AND ("languageFallbackFrom" IS NULL
        OR ("language" IS NOT NULL
          AND "languageFallbackFrom" <> "language"
          AND "languageFallbackFrom" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'))
    ) NOT VALID;
