-- DX-306: tipo de recurso de auditoría de los certificados del paciente
-- (justificante de asistencia y certificado de reposo): emitir, anular, ver
-- la lista e imprimir.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial: 20261223090100).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_CERTIFICATE';
