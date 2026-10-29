-- Excepción G5.3 (DX-334): país de sede anterior a DX-312.
--
-- DX-312: valida las FK y el CHECK de recetas de 20261031120000, comprueba el
-- relleno de 20261031120100 y pone el NOT NULL de "countryCode".
--
-- Orden y bloqueos (todo en una transacción; cada bloqueo dura hasta el
-- COMMIT):
--   1. VALIDATE de la FK de pending_registrations y del CHECK de recetas:
--      SHARE UPDATE EXCLUSIVE, no frena lecturas ni escrituras. Van antes de
--      tocar locations para que el recorrido de prescriptions no ocurra con
--      locations bloqueada.
--   2. Comprobación por clínica (con `app.current_tenant`, como el relleno:
--      con un owner sin BYPASSRLS, sin fijarla no vería ninguna fila y
--      pasaría sin mirar nada; no se fía de que la validación de la FK las
--      vea todas): si queda alguna sede sin "countryCode", con un
--      "countryCode" que no está en "countries" o con la columna antigua
--      distinta de la proyección de "countryCode", la migración falla y la
--      API no se despliega. Se investiga con la consulta posterior de la
--      spec (§3.6). Solo lee: no bloquea locations.
--   3. Validar la FK de locations cuenta como leer filas (DX-134, README
--      «Despliegue: roles de la BD»): con un owner sin BYPASSRLS y FORCE en
--      locations no vería ninguna sede y aceptaría huérfanas. locations pasa
--      a NO FORCE solo para validarla y vuelve a FORCE (countries no tiene
--      RLS). NO FORCE toma un ACCESS EXCLUSIVE sobre locations que dura
--      hasta el COMMIT: desde aquí, nadie lee ni escribe sedes. Lo que queda
--      solo recorre locations (pocas filas por clínica).
--   4. El NOT NULL sin recorrer la tabla dos veces: un CHECK NOT VALID, su
--      VALIDATE, SET NOT NULL (Postgres ≥ 12 usa el CHECK validado y no
--      recorre la tabla) y fuera el CHECK.
--
-- lock_timeout 5 s; para reintentar, `npx prisma migrate resolve
-- --rolled-back 20261031120200_dx312_location_country_code_validate` y el
-- deploy. A mano, siempre con `psql -1` (una transacción): sin ella, un
-- fallo tras el paso 3 dejaría locations en NO FORCE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "pending_registrations" VALIDATE CONSTRAINT "pending_registrations_location_country_code_fkey";
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_legacy_country_present_check";

DO $$
DECLARE
  t uuid;
  missing bigint;
  unknown bigint;
  incoherent bigint;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    SELECT pg_catalog.count(*) INTO missing FROM public."locations" l
     WHERE l."tenantId" = t AND l."countryCode" IS NULL;
    IF missing > 0 THEN
      RAISE EXCEPTION 'DX-312: % sedes sin país en la clínica %', missing, t;
    END IF;
    SELECT pg_catalog.count(*) INTO unknown FROM public."locations" l
     WHERE l."tenantId" = t
       AND NOT EXISTS (SELECT 1 FROM public."countries" c
                        WHERE c."code" = l."countryCode");
    IF unknown > 0 THEN
      RAISE EXCEPTION 'DX-312: % sedes con un país que no está en countries en la clínica %', unknown, t;
    END IF;
    SELECT pg_catalog.count(*) INTO incoherent FROM public."locations" l
     WHERE l."tenantId" = t
       AND l."country" IS DISTINCT FROM public.dx_legacy_clinic_country(l."countryCode");
    IF incoherent > 0 THEN
      RAISE EXCEPTION 'DX-312: % sedes con la columna antigua del país incoherente en la clínica %', incoherent, t;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" VALIDATE CONSTRAINT "locations_country_code_fkey";
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_country_code_not_null"
    CHECK ("countryCode" IS NOT NULL) NOT VALID;
ALTER TABLE "locations" VALIDATE CONSTRAINT "locations_country_code_not_null";
ALTER TABLE "locations" ALTER COLUMN "countryCode" SET NOT NULL;
ALTER TABLE "locations" DROP CONSTRAINT "locations_country_code_not_null";
