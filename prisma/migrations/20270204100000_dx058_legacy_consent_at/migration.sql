-- DX-058: fecha del resumen deprecado de los pacientes con fila LEGACY sin
-- `dataConsentAt`.
--
-- El backfill de 20261016170000 dio a quien había aceptado SIN fecha una fila
-- GENERAL LEGACY con `recordedAt = patients.updatedAt`, pero dejó
-- `patients.dataConsentAt = NULL`. El resumen dice «aceptó, sin fecha» y la
-- pestaña «Autorizaciones» enseña la fecha de la fila: dos fechas distintas
-- para la misma decisión. La regla del resumen (consent-state.ts,
-- deriveLegacyPatientConsent) es «la fecha de la última fila GENERAL»; aquí se
-- aplica a esos pacientes. Las filas no se tocan (son append-only).
--
-- Solo cuando la última fila GENERAL (mismo orden que la app: `recordedAt`
-- DESC, `id` DESC) es LEGACY y el resumen no tiene fecha. Idempotente: una
-- segunda pasada no encuentra nada. Solo escribe una columna deprecada que
-- nadie usa como prueba.

-- row_security = off: o se ven todas las filas o la migración falla (nunca 0
-- filas en silencio). DX-113: sin FORCE mientras dura, de vuelta al final.
-- El único DDL es ese NO FORCE/FORCE; el UPDATE toca solo los pacientes con
-- fila LEGACY y sin fecha (los del backfill de 2026-10-16, previos al piloto).
-- lint-migrations: ignore unbatched-dml: solo pacientes del backfill LEGACY de DX-037 sin fecha (pocos o ninguno), WHERE acotado por la última fila GENERAL
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "data_processing_consents" NO FORCE ROW LEVEL SECURITY;

UPDATE "patients" p
   SET "dataConsentAt" = latest."recordedAt"
  FROM (
    SELECT DISTINCT ON (c."patientId")
           c."patientId", c."channel", c."recordedAt"
      FROM "data_processing_consents" c
     WHERE c."scope" = 'GENERAL'
     ORDER BY c."patientId", c."recordedAt" DESC, c."id" DESC
  ) latest
 WHERE latest."patientId" = p."id"
   AND latest."channel" = 'LEGACY'
   AND p."dataConsentAt" IS NULL;

ALTER TABLE "data_processing_consents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
