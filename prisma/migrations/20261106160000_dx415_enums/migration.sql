-- DX-415: valor de enum nuevo de la aceptación del presupuesto a distancia.
--
-- Cambios:
--   EmailTemplate   signature-budget-accepted (el email que confirma al
--                   paciente que su aceptación quedó registrada, sin datos
--                   clínicos).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261106110000, DX-418).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'signature-budget-accepted';
