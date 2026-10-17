-- DX-210: tipo de recurso de auditoría para las ofertas de huecos libres
-- (registrar la oferta y anotar su resultado). ADD VALUE va solo en su
-- fichero: el valor nuevo no se puede usar en la misma transacción que lo
-- crea. Aditivo: el código anterior no lo conoce ni lo usa.
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'WAITLIST_OFFER';
