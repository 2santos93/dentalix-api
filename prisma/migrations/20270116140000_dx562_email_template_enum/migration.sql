-- DX-562: citas en serie. La plantilla del aviso único al paciente con todas
-- las fechas de la serie (`appointment-series`).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.
-- Vuelta atrás: no hace falta (un valor de enum sin usar no molesta).

SET LOCAL lock_timeout = '5s';

ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'appointment-series';
