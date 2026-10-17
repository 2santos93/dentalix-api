-- DX-150: tipos de recurso de auditoría para la cobranza: la gestión de cobro
-- (nota) y el compromiso de pago (crearlo y su cambio de estado). ADD VALUE va
-- solo en su fichero: el valor nuevo no se puede usar en la misma transacción
-- que lo crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'COLLECTION_NOTE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_PROMISE';
