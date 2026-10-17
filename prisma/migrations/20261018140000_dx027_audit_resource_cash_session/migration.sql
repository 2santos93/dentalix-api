-- DX-027: tipo de recurso de auditoría para la caja por turno (abrir, cerrar,
-- reabrir, ajustar, ver y los ajustes de caja de la clínica). ADD VALUE va solo
-- en su fichero: el valor nuevo no se puede usar en la misma transacción que
-- lo crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CASH_SESSION';
