-- DX-468: plantilla de email nueva para la copia de la receta.
--
-- Cambios:
--   EmailTemplate  prescription-copy (el email al paciente o al responsable
--                  de un menor con el enlace caducable a la copia informativa
--                  de una receta emitida).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'prescription-copy';
