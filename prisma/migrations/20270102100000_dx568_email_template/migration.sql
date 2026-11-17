-- DX-568: valor de enum del resumen semanal por email para el dueño.
--
-- Cambios:
--   EmailTemplate  weekly-digest  el resumen semanal de la clínica para sus
--                                 ADMIN (cifras por sede, sin datos de
--                                 pacientes).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice único parcial de email_outbox de
-- 20270102100100 lo usa).
--
-- Fecha: posterior a la última migración existente (20261231160000, DX-205).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'weekly-digest';
