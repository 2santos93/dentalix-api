-- DX-122: tipos de recurso de auditoría para los bloqueos de agenda y las
-- entradas de «Pendientes por agendar». ADD VALUE va solo en su fichero: un
-- valor nuevo no se puede usar en la misma transacción que lo crea. Aditivo: el
-- código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'SCHEDULE_BLOCK';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'WAITLIST_ENTRY';
