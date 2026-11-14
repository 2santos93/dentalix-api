-- SEC-043: el cierre a ciegas deja de ser un oráculo de «¿cuadra?».
--
-- Antes, cerrar sin motivo devolvía 400 si había diferencia y cerraba si no:
-- quien contaba a ciegas podía probar conteos hasta que uno pasara. Ahora el
-- cierre a ciegas de quien no es ADMIN se guarda SIEMPRE; si no cuadró y no
-- trae motivo, queda marcado «diferencia sin justificar» para que
-- administración lo revise.
--
-- Cambios (aditivos, compatibles hacia atrás):
--   cash_session_closings."unjustifiedDifference"  BOOLEAN NOT NULL DEFAULT
--       false. Con default constante, el ADD COLUMN no reescribe la tabla ni
--       dispara el trigger append-only (dx_cash_event_guard). Las filas ya
--       escritas quedan en false (todas tienen motivo si hubo diferencia).
--   cash_session_closings_reason_check  se reescribe: la diferencia exige
--       motivo SALVO en un cierre marcado sin justificar.
--   cash_session_closings_unjustified_check  la marca solo vale para un
--       cierre a ciegas, con diferencia y sin motivo.
-- El código anterior nunca escribe la columna (queda en false) y sigue
-- cumpliendo la regla de antes. Sin tablas nuevas: RLS FORCE y FK compuestas
-- de la tabla no cambian.

ALTER TABLE "cash_session_closings"
  ADD COLUMN "unjustifiedDifference" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "cash_session_closings"
  DROP CONSTRAINT "cash_session_closings_reason_check";

ALTER TABLE "cash_session_closings"
  ADD CONSTRAINT "cash_session_closings_reason_check"
    CHECK (NOT "hasDifference" OR "differenceReason" IS NOT NULL OR "unjustifiedDifference"),
  ADD CONSTRAINT "cash_session_closings_unjustified_check"
    CHECK (NOT "unjustifiedDifference"
           OR ("blind" AND "hasDifference" AND "differenceReason" IS NULL));
