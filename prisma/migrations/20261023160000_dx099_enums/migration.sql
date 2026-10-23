-- DX-099: enums de la anamnesis previa a la cita por enlace seguro.
--
-- Cambios:
--   MedicalHistorySubmissionStatus   estado de un envío: esperando al
--                          paciente, enviado (por revisar), aceptado,
--                          rechazado o caducado/anulado.
--   MedicalHistorySource   origen de una versión de la anamnesis: tecleada
--                          por el personal (todas las existentes) o aceptada
--                          desde el formulario del paciente.
--   DataConsentChannel     + PATIENT_LINK: la autorización SENSITIVE_HEALTH
--                          que da el propio paciente en el formulario público.
--   AuditResourceType      + MEDICAL_HISTORY_SUBMISSION (crear el enlace,
--                          envío, ver, aceptar, rechazar y anular).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (lo usan el CHECK de data_processing_consents,
-- el de audit_events y el índice parcial de audit_events, en las migraciones
-- siguientes).
--
-- Compatible hacia atrás: solo AÑADE dos tipos y dos valores que el código
-- anterior no conoce ni usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "MedicalHistorySubmissionStatus" AS ENUM (
  'PENDING_PATIENT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED'
);
CREATE TYPE "MedicalHistorySource" AS ENUM ('STAFF', 'PATIENT_FORM');

ALTER TYPE "DataConsentChannel" ADD VALUE IF NOT EXISTS 'PATIENT_LINK';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'MEDICAL_HISTORY_SUBMISSION';
