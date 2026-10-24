-- DX-279: enums de la política de cancelación por sede y de la cancelación
-- de una cita.
--
-- Cambios:
--   CancellationByKind      quién canceló: el paciente por el enlace público
--                           (DX-005), el personal en nombre del paciente o la
--                           propia clínica (que nunca cuenta como tardía).
--   CancellationReasonCode  catálogo CERRADO del motivo: enfermedad, olvido,
--                           costo, transporte, trabajo, la clínica reprograma,
--                           otro. Sin datos de salud obligatorios: el texto
--                           libre es opcional y limitado (500).
--   AuditResourceType       + CANCELLATION_POLICY (nueva versión de la política
--                           de una sede).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE dos tipos y un valor que el código
-- anterior no conoce ni usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "CancellationByKind" AS ENUM ('PATIENT_LINK', 'STAFF_FOR_PATIENT', 'CLINIC');
CREATE TYPE "CancellationReasonCode" AS ENUM (
  'ILLNESS', 'FORGOT', 'COST', 'TRANSPORT', 'WORK', 'CLINIC_RESCHEDULE', 'OTHER'
);

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CANCELLATION_POLICY';
