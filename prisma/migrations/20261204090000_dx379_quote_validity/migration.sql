-- DX-379 (porción A): la validez del presupuesto se guarda y la elige la
-- clínica.
--
--   tenants."quoteValidityDays"           INTEGER NOT NULL DEFAULT 30, 1..365
--   treatment_plans."quoteIssuedOn"       DATE NULL
--   treatment_plans."quoteValidUntil"     DATE NULL
--
-- Hasta ahora el presupuesto decía «válido 30 días desde hoy» cada vez que se
-- abría o se imprimía (`issuedOn` = hoy). Desde DX-379 las dos fechas se fijan
-- al presentar el plan (siempre) o al imprimirlo por primera vez (solo si
-- están vacías) y reimprimir otro día no las mueve. Días civiles de la sede
-- del presupuesto: DATE, sin zona y sin trigger UTC (DX-226), como
-- "manualExchangeRatesSince".
--
-- Sin relleno: los planes ya existentes quedan con NULL = «sin validez
-- guardada», nunca vencidos, y su presupuesto se compone como hasta ahora
-- (emitido hoy, hoy + el ajuste, que nace en 30 = lo de siempre). Los enlaces
-- de firma a distancia (DX-415) pendientes se recomponen con las fechas de su
-- propia foto, así que siguen valiendo.
--
-- Expand puro:
--   - `tenants`: NOT NULL con DEFAULT constante (PG 16: solo catálogo) y el
--     CHECK en la misma sentencia (una fila por clínica, milisegundos), como
--     DX-324 ("prescriptionValidityDays").
--   - `treatment_plans`: columnas NULL sin default (solo catálogo). Los CHECK
--     van NOT VALID aquí (todas las filas están a NULL) y se validan aparte
--     (20261204090100_dx379_quote_validity_validate, SHARE UPDATE EXCLUSIVE),
--     como DX-019-bis, para no recorrer la tabla bajo el ACCESS EXCLUSIVE del
--     ADD COLUMN.
--   - Una réplica anterior no nombra las columnas: crea clínicas con 30 y
--     presenta planes sin fechas (quedan como un plan anterior a DX-379).
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants` (toda petición la lee
-- al resolver la clínica) y de `treatment_plans`. Si falla, se reintenta el
-- deploy. Grants y RLS: las columnas heredan los de su tabla.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "quoteValidityDays" INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT "tenants_quote_validity_days_check"
    CHECK ("quoteValidityDays" BETWEEN 1 AND 365);

ALTER TABLE "treatment_plans"
  ADD COLUMN "quoteIssuedOn" DATE,
  ADD COLUMN "quoteValidUntil" DATE,
  -- Las dos o ninguna.
  ADD CONSTRAINT "treatment_plans_quote_validity_pair_check" CHECK (
    ("quoteIssuedOn" IS NULL) = ("quoteValidUntil" IS NULL)
  ) NOT VALID,
  -- Vence después de emitirse (el ajuste va de 1 a 365 días).
  ADD CONSTRAINT "treatment_plans_quote_validity_order_check" CHECK (
    "quoteValidUntil" > "quoteIssuedOn"
  ) NOT VALID;
