-- DX-561: valor de enum del aviso de seguimiento de un presupuesto presentado.
--
-- Cambios:
--   EmailTemplate  quote-follow-up  el aviso automático al paciente (o a su
--                                   responsable) de que tiene un presupuesto
--                                   pendiente de revisar, con el enlace de
--                                   aceptación de cada opción y la baja. Sin
--                                   importes ni tratamientos.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice único parcial de email_outbox de
-- 20270107140100 lo usa).
--
-- Fecha: posterior a la última migración existente (20270107090000, DX-464).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'quote-follow-up';
