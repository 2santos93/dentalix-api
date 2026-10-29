-- Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
--
-- DX-327: relleno de "documentType" desde el código antiguo, por lotes, sin
-- DDL. Molde de 20261024100100_dx287_patients_doc_key_backfill.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 filas.
-- Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de su lote, y
-- solo hasta su COMMIT. Recorrido por cursor (tenantId, id > último), no
-- ORDER BY … LIMIT sobre lo pendiente: cada lote cuesta lo mismo.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT: set_config(..., true) dura lo que
-- la transacción). Con un owner superusuario el resultado es el mismo.
--
-- Solo escribe "documentType" = dx_doc_type_from_legacy("docType"), también
-- en los pacientes borrados en blando y en los contactos responsables con
-- tipo. "docTypeLabel" no se toca: queda NULL (ningún código antiguo da
-- etiqueta). El trigger *_document_type ve la pareja coherente y no cambia
-- "docType": un TI sigue TI. Ningún otro trigger de las dos tablas mira
-- "documentType".
--
-- Idempotente: solo toca las filas cuyo genérico no es ya la traducción de
-- su antiguo. Si se corta a mitad (los lotes hechos quedan), basta con
-- repetirla (`prisma migrate resolve --rolled-back
-- 20261030120100_dx327_document_type_backfill` y `deploy`).
DO $$
DECLARE
  t uuid;
  last_id uuid;
  batch uuid[];
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    last_id := NULL;
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."patients" p
               WHERE p."tenantId" = t
                 AND (last_id IS NULL OR p."id" > last_id)
               ORDER BY p."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      UPDATE public."patients" p
         SET "documentType" = public.dx_doc_type_from_legacy(p."docType")
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."documentType" IS DISTINCT FROM public.dx_doc_type_from_legacy(p."docType");
      COMMIT;
    END LOOP;

    last_id := NULL;
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT r."id" FROM public."patient_responsible_parties" r
               WHERE r."tenantId" = t
                 AND (last_id IS NULL OR r."id" > last_id)
               ORDER BY r."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      UPDATE public."patient_responsible_parties" r
         SET "documentType" = public.dx_doc_type_from_legacy(r."docType")
       WHERE r."tenantId" = t
         AND r."id" = ANY (batch)
         AND r."docType" IS NOT NULL
         AND r."documentType" IS DISTINCT FROM public.dx_doc_type_from_legacy(r."docType");
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
