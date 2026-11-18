-- DX-101: tipo de recurso de auditoría del enlace de acceso del paciente
-- (alta y revocación por el personal; verificación y bloqueo desde el enlace).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_ACCESS_LINK';
