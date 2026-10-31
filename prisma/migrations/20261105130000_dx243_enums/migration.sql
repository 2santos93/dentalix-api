-- DX-243: valores de enum nuevos de la firma a distancia.
--
-- Cambios:
--   AuditResourceType   SIGNATURE_REQUEST (enviar, abrir, verificar el
--                       código, bloquear, firmar y anular una solicitud de
--                       firma a distancia).
--   EmailTemplate       signature-request (el email con el enlace) y
--                       signature-code (el del código de 6 dígitos).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (los de AuditResourceType los usan el índice de
-- 20261105130100_dx243_audit_events_idx y el CHECK de actor de
-- 20261105130200_dx243_signature_requests).
--
-- Fecha: posterior a la última migración existente (20261105120100, con fecha
-- futura, OPS-047) para que se ordene detrás.
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'SIGNATURE_REQUEST';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'signature-request';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'signature-code';
