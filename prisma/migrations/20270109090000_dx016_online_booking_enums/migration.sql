-- DX-016: reserva online. Valores de enum que usa el resto de migraciones del
-- ticket: el tipo de recurso de auditoría ONLINE_BOOKING y las plantillas de
-- email del código y del acuse.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ONLINE_BOOKING';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'online-booking-code';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'online-booking-received';
