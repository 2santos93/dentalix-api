-- DX-015: tipos de recurso de auditoría del recall: el recall del paciente
-- (fijar intervalo, desactivar) y el contacto de recall. ADD VALUE va solo en
-- su fichero: el valor nuevo no se puede usar en la misma transacción que lo
-- crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PATIENT_RECALL';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'RECALL_CONTACT';
