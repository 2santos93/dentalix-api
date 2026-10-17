-- DX-204: tipo de recurso de auditoría para el cambio de la política de
-- descuentos de la clínica (topes por rol y umbral del motivo). ADD VALUE va
-- solo en su fichero: el valor nuevo no se puede usar en la misma transacción
-- que lo crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DISCOUNT_POLICY';
