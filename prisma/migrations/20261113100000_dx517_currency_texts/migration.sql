-- DX-517: texto propio de cada moneda de la clínica. Los importes se pintan
-- con el código ISO 4217 (DX-378: «1.234,50 VES»); la clínica puede decir con
-- qué texto se escribe una moneda que usa («VES» → «Bs.»), y ese texto ocupa
-- el lugar del código en la posición que da el formato de la sede.
--
--   tenants."currencyTexts"   objeto jsonb {código ISO → texto}. '{}' = nada
--                             configurado: todo se pinta como antes.
--
-- Ningún país ni símbolo por defecto: el valor inicial es el objeto vacío.
-- La API valida cada entrada (código del catálogo `currencies`, texto de 1 a 8
-- caracteres sin espacios en los extremos ni caracteres de control, hasta 30
-- monedas) y responde 400 en español; el CHECK es la red (objeto y tamaño).
-- Los recibos emitidos congelan el mapa en su foto (DX-136): cambiarlo después
-- no reescribe ningún recibo.
--
-- Expand puro: NOT NULL con DEFAULT constante solo toca el catálogo en PG 16;
-- el CHECK se valida en la misma sentencia (todas las filas = '{}'; `tenants`
-- es pequeña). Una réplica anterior que inserta sin nombrar la columna recibe
-- '{}', que es «sin configurar». `tenants` no tiene RLS; la columna hereda el
-- grant de la tabla a dentalix_app.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "currencyTexts" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "tenants_currency_texts_check" CHECK (
    jsonb_typeof("currencyTexts") = 'object'
    AND pg_column_size("currencyTexts") <= 4096
  );
