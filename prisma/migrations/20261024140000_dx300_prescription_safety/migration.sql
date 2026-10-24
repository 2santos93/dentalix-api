-- DX-300: receta segura. La receta guarda los avisos de seguridad que el
-- servidor calculó al emitir (alergias con las casillas de la anamnesis,
-- interacciones, embarazo, antirresortivos, dosis infantil, sin anamnesis), la
-- versión de las reglas y el motivo con el que el profesional confirmó los
-- bloqueantes. Todo entra en el hash del contenido (formato v2).
--
-- Aditiva y compatible hacia atrás: tres columnas NULLABLE sin DEFAULT (solo
-- catálogo, sin reescribir la tabla). Las recetas ya emitidas quedan con NULL
-- y se siguen validando con el formato v1. El trigger "prescriptions_immutable"
-- compara la fila entera (to_jsonb), así que las columnas nuevas nacen ya
-- inmutables. Sin índices: ninguna consulta filtra ni ordena por ellas.
ALTER TABLE "prescriptions"
  ADD COLUMN "safetyRulesVersion" TEXT,
  ADD COLUMN "safetyAlerts" JSONB,
  ADD COLUMN "safetyOverrideReason" TEXT;

-- NOT VALID + VALIDATE: el ADD CONSTRAINT no recorre la tabla con el bloqueo
-- fuerte; la validación va aparte con un bloqueo que no frena las escrituras.
ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_safety_check" CHECK (
    ("safetyAlerts" IS NULL OR jsonb_typeof("safetyAlerts") = 'array')
    AND ("safetyAlerts" IS NULL) = ("safetyRulesVersion" IS NULL)
    AND (
      "safetyOverrideReason" IS NULL
      OR (
        "safetyAlerts" IS NOT NULL
        AND length(btrim("safetyOverrideReason")) BETWEEN 1 AND 500
      )
    )
  ) NOT VALID;
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_safety_check";
