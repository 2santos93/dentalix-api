-- DX-136: valores de enum del recibo de caja por abono.
--   AuditResourceType PAYMENT_RECEIPT  ver, reimprimir y enviar un recibo.
--   AuditAction       SEND             enviar un documento por email.
--   EmailTemplate     payment-receipt  el email con el recibo.
-- ADD VALUE va solo en su fichero: un valor nuevo no se puede usar en la misma
-- transacción que lo crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_RECEIPT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SEND';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'payment-receipt';
