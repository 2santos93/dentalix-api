-- DX-146: «Por avisar hoy» de la cartera. La marca «avisado» es una gestión
-- de cobranza más (collection_notes, append-only desde DX-150/DX-148) con un
-- resultado propio:
--
--   CollectionOutcome  REMINDER_SENT  se le avisó del saldo vencido (por el
--                                     enlace de WhatsApp, llamada o en
--                                     persona). Solo lo escribe
--                                     POST /patients/:id/balance-reminders.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa
-- (la API anterior no escribe REMINDER_SENT; si lee una nota con él, Prisma
-- la devuelve como un texto más).

SET LOCAL lock_timeout = '5s';

ALTER TYPE "CollectionOutcome" ADD VALUE IF NOT EXISTS 'REMINDER_SENT';
