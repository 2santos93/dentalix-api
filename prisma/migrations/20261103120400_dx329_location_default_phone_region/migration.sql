-- DX-329 (epic DX-311 «Producto global, sin supuestos de país»): prefijo
-- telefónico por defecto de la sede. "defaultPhoneRegion" es la región de
-- numeración (ISO 3166-1 alfa-2 de libphonenumber-js) cuyo prefijo se añade a
-- un teléfono escrito sin «+»; NULL es «sin prefijo por defecto» (el número
-- se escribe con «+»). "defaultPhoneRegionSetAt" es la marca de que la
-- decidió la API (alta, registro o edición), también cuando la dejó vacía.
--
-- Sin valor por defecto: una constante sería un país, y ningún país es el
-- de todas las clínicas. Un trigger «región = país si llega NULL» tampoco
-- vale: no distingue el null explícito de la API nueva del campo ausente de
-- una réplica anterior. Esa diferencia la lleva la marca.
--
-- Sin FK: la lista de regiones es la de la librería instalada, no la tabla
-- "countries" (la librería tiene regiones que no son países ISO, y algunos
-- países no tienen numeración propia). El CHECK solo exige la forma.
--
-- Convivencia: la API anterior no conoce las columnas (Prisma solo
-- selecciona las de su esquema), así que lee y actualiza igual; sus altas de
-- sede las dejan NULL. El relleno es 20261103120100 y, tras el despliegue de
-- la API, el UPDATE del runbook, que solo toca sedes sin marca.
--
-- ADD COLUMN sin default no reescribe la tabla. El CHECK recorre locations
-- (pequeña, columna vacía) bajo el ACCESS EXCLUSIVE breve del ALTER.
-- lock_timeout 5 s: si una transacción larga lo retiene, falla limpia; para
-- reintentar, `npx prisma migrate resolve --rolled-back
-- 20261103120000_dx329_location_default_phone_region` y de nuevo el deploy.
-- RLS FORCE no se toca.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "locations"
  ADD COLUMN "defaultPhoneRegion" CHAR(2),
  ADD COLUMN "defaultPhoneRegionSetAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "locations_default_phone_region_check"
    CHECK ("defaultPhoneRegion" IS NULL OR "defaultPhoneRegion" ~ '^[A-Z]{2}$');

COMMENT ON COLUMN "locations"."defaultPhoneRegion" IS
  'DX-329: región de numeración (ISO 3166-1 alfa-2 de libphonenumber-js) cuyo prefijo se añade a un teléfono escrito sin «+». NULL: sin prefijo por defecto. Se sugiere desde el país al crear la sede y se edita; ninguna regla lo deduce después del país.';
COMMENT ON COLUMN "locations"."defaultPhoneRegionSetAt" IS
  'DX-329: cuándo eligió la región la API (alta, registro o edición), también si la dejó vacía. NULL: la puso el relleno o la sede la creó una réplica anterior. Ningún relleno toca una sede con fecha.';
