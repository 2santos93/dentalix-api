-- DX-170: tipo de recurso de auditoría para las plantillas de evolución (crear,
-- editar, desactivar y cargar las de ejemplo). ADD VALUE va solo en su fichero:
-- el valor nuevo no se puede usar en la misma transacción que lo crea.
-- Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLINICAL_NOTE_TEMPLATE';
