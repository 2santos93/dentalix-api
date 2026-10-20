-- DX-222: plantilla de email con el enlace a las indicaciones postoperatorias.
--
-- Cambios:
--   EmailTemplate  post-op-instructions  el email con el enlace público.
--
-- ADD VALUE va solo en su fichero: un valor nuevo no se puede usar en la misma
-- transacción que lo crea. Compatible hacia atrás: solo AÑADE un valor que el
-- código anterior no conoce ni usa.
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'post-op-instructions';
