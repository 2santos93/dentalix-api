-- DX-038: tipo de recurso de auditoría para las adendas de la historia clínica.
-- ADD VALUE va solo en su fichero: el valor nuevo no se puede usar en la misma
-- transacción que lo crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLINICAL_ENTRY_ADDENDUM';
