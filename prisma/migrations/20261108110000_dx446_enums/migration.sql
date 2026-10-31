-- DX-446: huecos reservados para urgencias.
--
-- Cambios:
--   ScheduleBlockKind  RESERVED (bloque de agenda reservado para ciertos
--                      tipos de cita, p. ej. «Consulta de urgencia»).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (la CHECK de la migración siguiente lo nombra).
--
-- Fecha: posterior a la última migración existente (20261107160200, DX-443).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "ScheduleBlockKind" ADD VALUE IF NOT EXISTS 'RESERVED';
