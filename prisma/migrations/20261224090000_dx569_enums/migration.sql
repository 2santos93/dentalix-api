-- DX-569: valores de enum del enlace de pago por el que el paciente reporta
-- su pago.
--
-- Cambios:
--   AuditResourceType  PAYMENT_LINK             crear y enviar el enlace.
--                      PAYMENT_REPORT           el reporte del paciente:
--                                               enviado por el enlace,
--                                               confirmado, rechazado y ver
--                                               su comprobante.
--   EmailTemplate      payment-link             el email con el enlace.
--                      payment-report-rejected  el aviso de que la clínica no
--                                               pudo confirmar el pago.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261223090500,
-- DX-306).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_LINK';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_REPORT';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'payment-link';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'payment-report-rejected';
