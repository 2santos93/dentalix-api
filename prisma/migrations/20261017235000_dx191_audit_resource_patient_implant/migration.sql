-- DX-191: tipo de recurso de auditoría para el registro de implantes (alta,
-- anulación, tarjeta, búsqueda por lote y su CSV). ADD VALUE va solo en su
-- fichero: el valor nuevo no se puede usar en la misma transacción que lo crea.
-- Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_IMPLANT';
