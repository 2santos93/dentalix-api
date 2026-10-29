-- Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
--
-- DX-327: valida los CHECK de 20261030120000 y comprueba el relleno de
-- 20261030120100. VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE: no frena
-- las escrituras.
--
-- Comprobación por clínica (con `app.current_tenant`, como el relleno: con
-- un owner sin BYPASSRLS, sin fijarla no vería ninguna fila y pasaría sin
-- mirar nada): si queda una fila cuya pareja "docType"/"documentType" es
-- incoherente, o alguna con "docTypeLabel" escrito (antes de desplegar la
-- API nueva nadie puede haberla escrito: la columna es nueva y la API
-- anterior no la conoce), la migración falla y la API no se despliega. Se
-- investiga con la consulta posterior de la spec (§3.5).
--
-- lock_timeout 5 s; para reintentar, `npx prisma migrate resolve
-- --rolled-back 20261030120200_dx327_document_type_validate` y el deploy.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_doc_type_label_check";
ALTER TABLE "patient_responsible_parties" VALIDATE CONSTRAINT "patient_responsible_parties_doc_type_label_check";
ALTER TABLE "patient_responsible_parties" VALIDATE CONSTRAINT "patient_responsible_parties_document_type_check";

DO $$
DECLARE
  t uuid;
  incoherent bigint;
  labelled bigint;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    SELECT (SELECT pg_catalog.count(*) FROM public."patients" p
             WHERE p."tenantId" = t
               AND NOT public.dx_doc_type_coherent(p."docType", p."documentType"))
         + (SELECT pg_catalog.count(*) FROM public."patient_responsible_parties" r
             WHERE r."tenantId" = t
               AND NOT public.dx_doc_type_coherent(r."docType", r."documentType"))
      INTO incoherent;
    IF incoherent > 0 THEN
      RAISE EXCEPTION 'DX-327: % filas con el tipo de documento incoherente en la clínica %', incoherent, t;
    END IF;
    SELECT (SELECT pg_catalog.count(*) FROM public."patients" p
             WHERE p."tenantId" = t AND p."docTypeLabel" IS NOT NULL)
         + (SELECT pg_catalog.count(*) FROM public."patient_responsible_parties" r
             WHERE r."tenantId" = t AND r."docTypeLabel" IS NOT NULL)
      INTO labelled;
    IF labelled > 0 THEN
      RAISE EXCEPTION 'DX-327: % filas con etiqueta de documento antes del despliegue en la clínica %', labelled, t;
    END IF;
  END LOOP;
END
$$;
