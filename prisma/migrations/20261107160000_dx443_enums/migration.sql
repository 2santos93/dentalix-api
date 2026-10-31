-- DX-443: plantilla de email nueva para la copia del PDF firmado.
--
-- Cambios:
--   EmailTemplate  signed-consent-copy (el email al paciente o a su
--                  responsable con el enlace de un solo uso para descargar
--                  su copia del consentimiento firmado a distancia).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261107150000, DX-438).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'signed-consent-copy';
