-- DX-253: valor de enum nuevo del saldo a favor del paciente.
--
-- Cambios:
--   AuditResourceType   PATIENT_CREDIT (traspaso de saldo a favor a otro plan,
--                       devolución y su comprobante, y el tope de recepción).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261106130001_dx253_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_CREDIT';
