-- DX-439: valor de enum nuevo de «Pendiente de cerrar».
--
-- Cambios:
--   AuditResourceType   CLOSING_QUEUE_DISMISSAL (el descarte de un pendiente
--                       de cierre, con su sección, cita y motivo).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261107120100, DX-427).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLOSING_QUEUE_DISMISSAL';
