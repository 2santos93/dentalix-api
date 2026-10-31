-- Anamnesis: embarazo tri-estado (Sí / No / No sabe; NULL = sin responder).
--
-- Antes solo se guardaba la bandera derivada `safetyFlags.embarazo`: un «No»
-- elegido y una pregunta no hecha quedaban iguales (`false`).
--
-- APPEND-ONLY / médico-legal: `medical_history_versions` prohíbe el UPDATE
-- (trigger medical_history_versions_immutable). Esta migración NO toca ni
-- reinterpreta ninguna fila: solo AÑADE un tipo y una columna NULLABLE sin
-- default (sin reescritura de la tabla). Las versiones existentes quedan con
-- NULL y se leen como se registraron (`readStoredPregnancy`): «Sí» si su
-- bandera lo dice; si no, sin responder (nunca un «No» que nadie registró).
--
-- Los hábitos (JSON) pasan a la forma tri-estado SOLO en las versiones nuevas;
-- las anteriores conservan sus booleanos y se leen con `readStoredHabits`
-- (true «Sí», false «No»). Sin SQL para eso: no se reescribe nada.

CREATE TYPE "AnamnesisAnswerStatus" AS ENUM ('SI', 'NO', 'DESCONOCE');

ALTER TABLE "medical_history_versions" ADD COLUMN "pregnancy" "AnamnesisAnswerStatus";

-- La bandera derivada y la respuesta no pueden contradecirse en lo nuevo:
-- embarazo = true  ⇔  pregnancy = 'SI'. NOT VALID: no se revisan (ni se
-- tocan) las filas anteriores, que tienen pregnancy NULL.
ALTER TABLE "medical_history_versions"
  ADD CONSTRAINT "mhv_pregnancy_flag_check"
  CHECK (
    "pregnancy" IS NULL
    OR "safetyFlags" IS NULL
    OR (("pregnancy" = 'SI') = COALESCE(("safetyFlags"->>'embarazo')::boolean, false))
  ) NOT VALID;
