-- DX-137: valor de enum del aviso «Nuevo inicio de sesión».
--
-- Cambios:
--   EmailTemplate  new-login  aviso al usuario cuando entra desde un dispositivo
--                             que no se vio en 90 días, con el enlace «No fui yo».
--
-- ADD VALUE va en su propio fichero (molde de DX-568): un valor nuevo no se
-- puede usar en la misma transacción que lo crea.
--
-- Fecha: posterior a la última migración de main (20270107140300, DX-561).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'new-login';
