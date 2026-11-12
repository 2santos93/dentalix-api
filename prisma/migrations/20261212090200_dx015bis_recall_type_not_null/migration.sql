-- DX-015-bis: cierra el relleno. Todo recall tiene tipo (NOT NULL) y hay uno
-- por paciente y TIPO; la unicidad por "kind" se suelta DESPUÉS de crear la
-- nueva, así nunca queda la tabla sin ninguna.
--
-- Falla de forma ruidosa si queda algún recall sin tipo (una clínica sin el
-- tipo de su "kind"): no se cierra a ciegas. Si falla, basta con repetir el
-- deploy (`prisma migrate resolve --rolled-back` de esta migración).
--
-- patient_recalls es pequeña: CREATE UNIQUE INDEX sin CONCURRENTLY (SHARE, un
-- instante) y SET NOT NULL (ACCESS EXCLUSIVE con un recorrido corto), con
-- lock_timeout para fallar limpio. Un CHECK ve todas las filas aunque el owner
-- esté sujeto a la RLS (DX-134); el recuento previo, no, así que se comprueba
-- con el CHECK.
SET LOCAL lock_timeout = '5s';

-- Un alta de la app vieja entre el COMMIT de su clínica en 20261212090100 y
-- aquí ya trae su tipo (trigger `patient_recalls_compat_v1`); por si alguna
-- llegó antes del trigger o sin tipos sembrados, se rellena aquí, clínica a
-- clínica (con la RLS del owner) y en esta misma transacción: lo que quede
-- sin tipo después es de una clínica sin el tipo de su "kind" y debe fallar.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM public.dx_recall_seed_default_types(t);
    UPDATE public."patient_recalls" pr
       SET "recallTypeId" = rt."id"
      FROM public."recall_types" rt
     WHERE pr."tenantId" = t
       AND pr."recallTypeId" IS NULL
       AND rt."tenantId" = t
       AND rt."systemKey" = pr."kind";
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);
END
$$;

ALTER TABLE "patient_recalls"
  ADD CONSTRAINT "patient_recalls_type_check" CHECK ("recallTypeId" IS NOT NULL) NOT VALID;
ALTER TABLE "patient_recalls" VALIDATE CONSTRAINT "patient_recalls_type_check";
ALTER TABLE "patient_recalls" ALTER COLUMN "recallTypeId" SET NOT NULL;
ALTER TABLE "patient_recalls" DROP CONSTRAINT "patient_recalls_type_check";

CREATE UNIQUE INDEX "patient_recalls_tenant_patient_type_key"
  ON "patient_recalls"("tenantId", "patientId", "recallTypeId");
DROP INDEX "patient_recalls_tenant_patient_kind_key";
-- El nuevo cubre el lado hijo de la FK del tipo solo con el paciente delante;
-- el de 20261212090000 ("tenantId", "recallTypeId") se queda para la FK.
