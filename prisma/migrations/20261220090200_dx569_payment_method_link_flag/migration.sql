-- DX-569: «Permitir en el enlace de pago» en cada medio de pago.
--
-- NOT NULL DEFAULT false: en Postgres ≥ 11 añadir una columna con un default
-- constante no reescribe la tabla (solo el catálogo). Ningún medio se ofrece
-- en un enlace hasta que el ADMIN lo permita y escriba sus datos para pagar.
--
-- Compatible hacia atrás: el código anterior no lee la columna y sus INSERT
-- reciben el default.
--
-- Vuelta atrás: ALTER TABLE "payment_methods" DROP COLUMN "allowInPaymentLink";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payment_methods"
  ADD COLUMN "allowInPaymentLink" BOOLEAN NOT NULL DEFAULT false;
