-- DX-588: pantallas de sala de espera. Recurso de auditoría nuevo:
--   WAITING_ROOM_SCREEN  alta, cambios (nombre, modo de nombre, mensajes,
--                        sonido) y revocación de una pantalla. Nunca cada
--                        lectura del tablero público.
--
-- Solo el valor: su índice parcial de audit_events va en
-- 20270130090100 (un valor nuevo no se puede usar en la transacción que lo
-- crea). Aditiva. IF NOT EXISTS: idempotente.

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'WAITING_ROOM_SCREEN';
