-- DX-329: relleno del prefijo telefónico por defecto de cada sede desde su
-- país, clínica a clínica, sin DDL. Molde de
-- 20261031120100_dx312_location_country_code_backfill.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Las sedes
-- por clínica son pocas: no hace falta cursor. Ninguna clínica toma ACCESS
-- EXCLUSIVE: solo los bloqueos de fila de sus sedes, y solo hasta su COMMIT.
-- A mano, sin `psql -1`.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en
-- cada una (vuelve a fijarse tras cada COMMIT: set_config(..., true) dura lo
-- que la transacción). Con un owner superusuario el resultado es el mismo.
--
-- Escribe "defaultPhoneRegion" = "countryCode" en todas las sedes, también
-- las borradas en blando: cada una recibe lo que recibiría una sede nueva de
-- su país. Si la librería no tiene numeración para ese país, la API lo lee
-- como sin prefijo. NO escribe la marca "defaultPhoneRegionSetAt": la región
-- la puso el relleno, no una persona. Ningún trigger de locations se dispara
-- con esta columna, y "updatedAt" no cambia.
--
-- Idempotente: solo toca las sedes sin región y sin marca, así que nunca
-- pisa una región que eligió o vació un ADMIN. Si se corta a mitad (las
-- clínicas hechas quedan), basta con repetirla (`prisma migrate resolve
-- --rolled-back 20261103120100_dx329_location_default_phone_region_backfill`
-- y `deploy`).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    UPDATE public."locations" l
       SET "defaultPhoneRegion" = l."countryCode"
     WHERE l."tenantId" = t
       AND l."defaultPhoneRegion" IS NULL
       AND l."defaultPhoneRegionSetAt" IS NULL;
    COMMIT;
  END LOOP;
END
$$;
