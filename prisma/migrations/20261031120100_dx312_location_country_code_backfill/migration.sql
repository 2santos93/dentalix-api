-- Excepción G5.3 (DX-334): país de sede anterior a DX-312.
--
-- DX-312: relleno de "countryCode" desde la columna antigua, clínica a
-- clínica, sin DDL. Molde de 20261030120100_dx327_document_type_backfill.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Las sedes
-- por clínica son pocas: no hace falta cursor. Ninguna clínica toma ACCESS
-- EXCLUSIVE: solo los bloqueos de fila de sus sedes, y solo hasta su COMMIT.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en
-- cada una (vuelve a fijarse tras cada COMMIT: set_config(..., true) dura lo
-- que la transacción). Con un owner superusuario el resultado es el mismo.
--
-- Solo escribe "countryCode" = "country"::text, también en las sedes
-- borradas en blando y en las que aún no tienen datos regionales. El trigger
-- locations_country_code ve un "countryCode" nuevo y escribe en la columna
-- antigua su proyección, que para los dos valores del enum es el mismo
-- valor: la columna antigua no cambia. Después, los pendientes
-- (pending_registrations es global, sin RLS), con el trigger equivalente.
--
-- Idempotente: solo toca las filas sin "countryCode". Si se corta a mitad
-- (las clínicas hechas quedan), basta con repetirla (`prisma migrate
-- resolve --rolled-back 20261031120100_dx312_location_country_code_backfill`
-- y `deploy`).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    UPDATE public."locations" l
       SET "countryCode" = l."country"::text
     WHERE l."tenantId" = t
       AND l."countryCode" IS NULL
       AND l."country" IS NOT NULL;
    COMMIT;
  END LOOP;

  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  UPDATE public."pending_registrations" r
     SET "locationCountryCode" = r."locationCountry"::text
   WHERE r."locationCountry" IS NOT NULL
     AND r."locationCountryCode" IS NULL;
  COMMIT;
END
$$;
