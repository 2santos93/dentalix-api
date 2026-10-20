-- DX-151: enums de los documentos del paciente.
--
-- Cambios:
--   PatientDocumentCategory  categoría de un documento: radiografía, foto,
--                            remisión, consentimiento firmado, informe u otro.
--   AuditResourceType        PATIENT_DOCUMENT (subir, ver, descargar, anular).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261020200200_dx151_audit_events_idx). La tabla que usa el tipo nuevo va
-- en 20261020200100_dx151_patient_documents.
--
-- Compatible hacia atrás: solo AÑADE un tipo y un valor que el código
-- anterior no conoce ni usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PatientDocumentCategory" AS ENUM ('XRAY', 'PHOTO', 'REFERRAL', 'SIGNED_CONSENT', 'REPORT', 'OTHER');

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_DOCUMENT';
