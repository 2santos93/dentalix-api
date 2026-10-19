-- DX-212: tipos de recurso de auditoría para los cambios del catálogo (código
-- CUPS) y de las sedes (código de habilitación REPS). ADD VALUE va solo en su
-- fichero: el valor nuevo no se puede usar en la misma transacción que lo
-- crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DENTAL_CATALOG_ITEM';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'LOCATION';
