-- DX-107: enums de la importación de pacientes desde CSV/XLSX.
--
-- Cambios:
--   PatientImportStatus         estado de un lote (validado, en cola, en
--                               curso, terminado, fallido, deshecho, caducado).
--   PatientImportDuplicateMode  qué hacer con un paciente que ya existe:
--                               saltarlo o rellenar solo sus campos vacíos.
--   PatientImportFileFormat     CSV o XLSX.
--   PatientImportRowOutcome     resultado de cada fila preparada.
--   AuditResourceType           PATIENT_IMPORT_BATCH (validar, confirmar,
--                               deshacer y descargar el informe de un lote).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261022130200_dx107_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE tipos y un valor que el código anterior
-- no conoce ni usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PatientImportStatus" AS ENUM ('VALIDATED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNDONE', 'EXPIRED');
CREATE TYPE "PatientImportDuplicateMode" AS ENUM ('SKIP', 'FILL_EMPTY');
CREATE TYPE "PatientImportFileFormat" AS ENUM ('CSV', 'XLSX');
CREATE TYPE "PatientImportRowOutcome" AS ENUM ('PENDING', 'CREATED', 'FILLED', 'SKIPPED', 'FAILED');

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_IMPORT_BATCH';
