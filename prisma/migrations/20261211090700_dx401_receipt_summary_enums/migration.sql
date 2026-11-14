-- DX-401: valores de enum del resumen de abonos de un período por paciente.
--
-- Cambios:
--   AuditResourceType  PAYMENT_RECEIPT_SUMMARY  ver, imprimir y enviar el
--                      resumen de los recibos de un período del paciente.
--   EmailTemplate      payment-receipt-summary  el email con ese resumen
--                      (con su propio tope por plantilla, como el recibo).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261211090600, DX-455).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_RECEIPT_SUMMARY';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'payment-receipt-summary';
