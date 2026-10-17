-- DX-048: tipo de recurso de auditoría para las acciones de un ADMIN sobre un
-- miembro del personal (desbloquear su inicio de sesión). ADD VALUE va solo en
-- su fichero: el valor nuevo no se puede usar en la misma transacción que lo
-- crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'STAFF_MEMBER';
