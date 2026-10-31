-- DX-439: valor de enum nuevo de «Pendiente de cerrar».
--
-- Cambios:
--   AuditResourceType   CLOSING_QUEUE_DISMISSAL (el descarte de un pendiente
--                       de cierre, con su sección, cita y motivo).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a las migraciones de main en el momento del rebase
-- (20261107150000, DX-438).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLOSING_QUEUE_DISMISSAL';
