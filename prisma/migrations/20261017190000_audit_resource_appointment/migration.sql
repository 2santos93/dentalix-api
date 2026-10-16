-- DX-121: tipo de recurso de auditoría para mover una cita (hora y profesional
-- antes y después). ADD VALUE va solo en su fichero: el valor nuevo no se puede
-- usar en la misma transacción que lo crea. Aditivo: el código anterior no lo
-- conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'APPOINTMENT';
