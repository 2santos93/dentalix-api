-- SEC-009: tipo de recurso de auditoría para las acciones de un ADMIN sobre un
-- dominio personalizado (verificarlo, eliminarlo). ADD VALUE va solo en su
-- fichero: el valor nuevo no se puede usar en la misma transacción que lo
-- crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'TENANT_DOMAIN';
