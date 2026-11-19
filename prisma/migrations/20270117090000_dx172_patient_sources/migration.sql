-- DX-172: origen del paciente («¿Cómo nos conoció?») y quién lo refirió.
--
-- Cambios (ADITIVOS, compatibles hacia atrás: el código anterior no lee ni
-- escribe nada de esto):
--   PatientSourceKind     CHANNEL | PATIENT | EXTERNAL_PROFESSIONAL.
--   patient_sources       catálogo de la clínica (nombre 2–60 único sin
--                         distinguir mayúsculas, tipo, activo, clave de las
--                         sembradas, orden). RLS ENABLE + FORCE con la política
--                         NULLIF (DX-251); FK directa a tenants con RESTRICT.
--                         No se borra: sin DELETE ni TRUNCATE para la app (se
--                         desactiva y los pacientes la conservan).
--   dx_patient_sources_ensure(tenant)  siembra las 9 fuentes por defecto SOLO
--                         si la clínica no tiene ninguna (alta de clínica, el
--                         relleno de 20270117090100 y la app al leer un
--                         catálogo vacío). SECURITY INVOKER: con la RLS de quien
--                         llama (fija antes app.current_tenant). Español neutro,
--                         sin marcas ni nada de un país.
--   patients."sourceId"            FK COMPUESTA a patient_sources.
--   patients."referredByPatientId" FK COMPUESTA a patients (misma clínica).
--   patients."referredByName"      profesional externo (1–120, recortado).
--                         CHECKs: nadie se recomienda a sí mismo; referente o
--                         nombre solo con fuente; nunca los dos a la vez. FK y
--                         CHECK NOT VALID (columnas nuevas, todas NULL): su
--                         VALIDATE va en 20270117090400.
--   dx_merge_patients     CREATE OR REPLACE de la definición de 20261226140000
--                         (la única) + la captación: los recomendados del
--                         absorbido pasan al conservado, el conservado nunca
--                         queda recomendado por sí mismo y, sin fuente, hereda
--                         la del absorbido. La columna no se llama "patientId":
--                         no está en dx_patient_merge_tables() (lista cerrada
--                         de DX-266); va en NOT_MOVED de patient-merge.int-spec.
--
-- Los índices de patients (tabla caliente, DX-148) van CONCURRENTLY en sus
-- propias migraciones (20270117090200 y 20270117090300).
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_merge_patients con la
-- definición de 20261226140000 y
--   ALTER TABLE public."patients"
--     DROP CONSTRAINT "patients_source_fkey",
--     DROP CONSTRAINT "patients_referred_by_fkey",
--     DROP CONSTRAINT "patients_referred_by_self_check",
--     DROP CONSTRAINT "patients_referral_needs_source_check",
--     DROP CONSTRAINT "patients_referral_one_check",
--     DROP CONSTRAINT "patients_referred_by_name_check",
--     DROP COLUMN "sourceId", DROP COLUMN "referredByPatientId",
--     DROP COLUMN "referredByName";
--   DROP FUNCTION public.dx_patient_sources_ensure(uuid);
--   DROP TABLE public."patient_sources"; DROP TYPE "PatientSourceKind";

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PatientSourceKind" AS ENUM ('CHANNEL', 'PATIENT', 'EXTERNAL_PROFESSIONAL');

-- ---------------------------------------------------------------------------
-- patient_sources
-- ---------------------------------------------------------------------------

CREATE TABLE "patient_sources" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PatientSourceKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "systemKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_sources_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_sources_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 2 AND 60 AND "name" = btrim("name")),
    CONSTRAINT "patient_sources_system_key_check"
      CHECK ("systemKey" IS NULL OR "systemKey" ~ '^[A-Z][A-Z_]{1,39}$')
);

-- Destino de la FK compuesta de patients (SEC-004) y lado hijo de la de tenant.
CREATE UNIQUE INDEX "patient_sources_tenant_id_key" ON "patient_sources"("tenantId", "id");
CREATE UNIQUE INDEX "patient_sources_tenant_system_key" ON "patient_sources"("tenantId", "systemKey");
CREATE UNIQUE INDEX "patient_sources_tenant_name_key" ON "patient_sources"("tenantId", lower("name"));

ALTER TABLE "patient_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_sources"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_sources" FORCE ROW LEVEL SECURITY;

-- Se desactiva, no se borra.
REVOKE DELETE, TRUNCATE ON "patient_sources" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Siembra: las 9 fuentes por defecto, solo en una clínica sin ninguna
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dx_patient_sources_ensure(p_tenant uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'DX172_NO_TENANT' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public."patient_sources" s WHERE s."tenantId" = p_tenant) THEN
    RETURN false;
  END IF;
  INSERT INTO public."patient_sources"
    ("id", "tenantId", "name", "kind", "isActive", "systemKey", "sortOrder", "createdAt", "updatedAt")
  SELECT pg_catalog.gen_random_uuid(), p_tenant, v."name", v."kind"::public."PatientSourceKind",
         true, v."systemKey", v."sortOrder",
         pg_catalog.timezone('UTC', pg_catalog.now()), pg_catalog.timezone('UTC', pg_catalog.now())
    FROM (VALUES
      ('Recomendación de paciente', 'PATIENT', 'PATIENT_REFERRAL', 10),
      ('Instagram', 'CHANNEL', 'INSTAGRAM', 20),
      ('Facebook', 'CHANNEL', 'FACEBOOK', 30),
      ('Google', 'CHANNEL', 'GOOGLE', 40),
      ('Marketplace de reservas', 'CHANNEL', 'BOOKING_MARKETPLACE', 50),
      ('Convenio/empresa', 'CHANNEL', 'AGREEMENT', 60),
      ('Profesional externo', 'EXTERNAL_PROFESSIONAL', 'EXTERNAL_PROFESSIONAL', 70),
      ('Paso por la sede', 'CHANNEL', 'WALK_IN', 80),
      ('Otro', 'CHANNEL', 'OTHER', 90)
    ) AS v("name", "kind", "systemKey", "sortOrder")
  -- Dos llamadas a la vez (dos lecturas del catálogo vacío): la segunda no
  -- duplica nada.
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.dx_patient_sources_ensure(uuid) IS
  'DX-172: fuentes de captación por defecto de una clínica sin ninguna (alta, relleno y app). Idempotente.';

REVOKE ALL ON FUNCTION public.dx_patient_sources_ensure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_patient_sources_ensure(uuid) TO dentalix_app;

-- ---------------------------------------------------------------------------
-- patients: fuente, referente y profesional externo
-- ---------------------------------------------------------------------------

ALTER TABLE "patients"
  ADD COLUMN "sourceId" UUID,
  ADD COLUMN "referredByPatientId" UUID,
  ADD COLUMN "referredByName" TEXT;

ALTER TABLE "patients" ADD CONSTRAINT "patients_source_fkey"
  FOREIGN KEY ("tenantId", "sourceId") REFERENCES "patient_sources"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patients" ADD CONSTRAINT "patients_referred_by_fkey"
  FOREIGN KEY ("tenantId", "referredByPatientId") REFERENCES "patients"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patients" ADD CONSTRAINT "patients_referred_by_self_check"
  CHECK ("referredByPatientId" IS NULL OR "referredByPatientId" <> "id") NOT VALID;
ALTER TABLE "patients" ADD CONSTRAINT "patients_referral_needs_source_check"
  CHECK (("referredByPatientId" IS NULL AND "referredByName" IS NULL) OR "sourceId" IS NOT NULL) NOT VALID;
ALTER TABLE "patients" ADD CONSTRAINT "patients_referral_one_check"
  CHECK ("referredByPatientId" IS NULL OR "referredByName" IS NULL) NOT VALID;
ALTER TABLE "patients" ADD CONSTRAINT "patients_referred_by_name_check"
  CHECK ("referredByName" IS NULL
         OR (char_length("referredByName") BETWEEN 1 AND 120 AND "referredByName" = btrim("referredByName")))
  NOT VALID;

-- ---------------------------------------------------------------------------
-- La fusión (DX-266) con la captación
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dx_merge_patients(p_absorbed uuid, p_kept uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  v_now timestamp(3) := pg_catalog.timezone('UTC', pg_catalog.now());
  v_absorbed record;
  v_kept record;
  v_found integer;
  v_n bigint;
  v_resolved jsonb := '{}'::jsonb;
  v_moved jsonb;
  v_table text;
  v_ctes text[] := ARRAY[]::text[];
  v_counts text[] := ARRAY[]::text[];
  v_i integer := 0;
  v_consent_absorbed timestamp(3);
  v_consent_kept timestamp(3);
  v_blockers text[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'DX266_NO_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_absorbed IS NULL OR p_kept IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'DX266_INVALID' USING ERRCODE = 'DX266';
  END IF;
  IF p_absorbed = p_kept THEN
    RAISE EXCEPTION 'DX266_SAME_PATIENT' USING ERRCODE = 'DX266';
  END IF;

  -- Los dos, bloqueados en orden de id: dos fusiones a la vez sobre el mismo
  -- paciente (también cruzadas, A→B y B→A) se ponen en cola y la segunda ve
  -- al absorbido ya retirado.
  SELECT pg_catalog.count(*) INTO v_found
    FROM (SELECT 1 FROM public."patients" p
           WHERE p."tenantId" = v_tenant AND p."id" IN (p_absorbed, p_kept)
           ORDER BY p."id"
             FOR UPDATE OF p) locked;
  IF v_found <> 2 THEN
    RAISE EXCEPTION 'DX266_NOT_FOUND' USING ERRCODE = 'DX266';
  END IF;
  SELECT p."deletedAt", p."last_attention_at", p."retention_extended",
         p."retention_floor_until", p."dataConsentAccepted", p."dataConsentAt",
         p."dataConsentPolicyVersion"
    INTO v_absorbed
    FROM public."patients" p WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed;
  SELECT p."deletedAt", p."last_attention_at", p."retention_extended",
         p."retention_floor_until"
    INTO v_kept
    FROM public."patients" p WHERE p."tenantId" = v_tenant AND p."id" = p_kept;
  -- Un archivado (o ya fusionado) no entra: se desarchiva antes, si procede.
  IF v_absorbed."deletedAt" IS NOT NULL OR v_kept."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'DX266_PATIENT_INACTIVE' USING ERRCODE = 'DX266';
  END IF;

  -- Lo que no se puede resolver solo: lo decide la clínica antes (el mismo
  -- cálculo que enseña la vista previa).
  v_blockers := public.dx_patient_merge_blockers(p_absorbed, p_kept);
  IF pg_catalog.cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION '%', v_blockers[1] USING ERRCODE = 'DX266';
  END IF;

  -- Desde aquí, la puerta de las guardas está abierta para esta pareja.
  PERFORM pg_catalog.set_config('dentalix.patient_merge',
    v_tenant::text || ':' || p_absorbed::text || ':' || p_kept::text, true);

  -- Únicos «uno por paciente»: gana el conservado; lo del absorbido se cierra
  -- como lo cerraría la clínica (sin borrar nada) y después se mueve igual.
  UPDATE public."appointment_waitlist" w
     SET "status" = 'DISMISSED', "dismissReason" = 'Paciente fusionado',
         "resolvedAt" = v_now, "resolvedById" = p_actor, "updatedAt" = v_now
   WHERE w."tenantId" = v_tenant AND w."patientId" = p_absorbed AND w."status" = 'OPEN'
     AND EXISTS (SELECT 1 FROM public."appointment_waitlist" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."status" = 'OPEN');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('waitlistDismissed', v_n); END IF;

  UPDATE public."patient_agreements" a
     SET "deletedAt" = v_now, "updatedById" = p_actor, "updatedAt" = v_now
   WHERE a."tenantId" = v_tenant AND a."patientId" = p_absorbed AND a."deletedAt" IS NULL
     AND EXISTS (SELECT 1 FROM public."patient_agreements" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."deletedAt" IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('agreementsEnded', v_n); END IF;

  UPDATE public."patient_coverages" c
     SET "isPrimary" = false, "updatedById" = p_actor, "updatedAt" = v_now
   WHERE c."tenantId" = v_tenant AND c."patientId" = p_absorbed AND c."isPrimary" AND c."deletedAt" IS NULL
     AND EXISTS (SELECT 1 FROM public."patient_coverages" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."isPrimary" AND k."deletedAt" IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('coveragesNoLongerPrimary', v_n); END IF;

  UPDATE public."patient_coverages" c
     SET "migratedFromLegacyInsurer" = false, "updatedById" = p_actor, "updatedAt" = v_now
   WHERE c."tenantId" = v_tenant AND c."patientId" = p_absorbed AND c."migratedFromLegacyInsurer"
     AND EXISTS (SELECT 1 FROM public."patient_coverages" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."migratedFromLegacyInsurer");

  -- Responsables: el vínculo entre los dos ya no tiene sentido (sería el
  -- paciente responsable de sí mismo): se retira y se queda en el absorbido.
  UPDATE public."patient_responsible_parties" r
     SET "deletedAt" = v_now, "updatedAt" = v_now
   WHERE r."tenantId" = v_tenant AND r."deletedAt" IS NULL
     AND r."patientId" IN (p_absorbed, p_kept) AND r."responsiblePatientId" IN (p_absorbed, p_kept);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('responsibleLinksBetweenPair', v_n); END IF;
  -- El mismo responsable (paciente) de los dos, o el absorbido responsable de
  -- alguien que ya tiene al conservado: queda el del conservado.
  UPDATE public."patient_responsible_parties" r
     SET "deletedAt" = v_now, "updatedAt" = v_now
   WHERE r."tenantId" = v_tenant AND r."deletedAt" IS NULL AND (
         (r."patientId" = p_absorbed AND r."responsiblePatientId" IS NOT NULL
          AND EXISTS (SELECT 1 FROM public."patient_responsible_parties" k
                       WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept
                         AND k."responsiblePatientId" = r."responsiblePatientId" AND k."deletedAt" IS NULL))
      OR (r."responsiblePatientId" = p_absorbed
          AND EXISTS (SELECT 1 FROM public."patient_responsible_parties" k
                       WHERE k."tenantId" = v_tenant AND k."patientId" = r."patientId"
                         AND k."responsiblePatientId" = p_kept AND k."deletedAt" IS NULL)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('responsibleLinksDuplicated', v_n); END IF;
  UPDATE public."patient_responsible_parties" r
     SET "isPayer" = false, "updatedAt" = v_now
   WHERE r."tenantId" = v_tenant AND r."patientId" = p_absorbed AND r."isPayer" AND r."deletedAt" IS NULL
     AND EXISTS (SELECT 1 FROM public."patient_responsible_parties" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."isPayer" AND k."deletedAt" IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('responsiblePayersCleared', v_n); END IF;
  UPDATE public."patient_responsible_parties" r
     SET "migratedFromGuardian" = false, "updatedAt" = v_now
   WHERE r."tenantId" = v_tenant AND r."patientId" = p_absorbed AND r."migratedFromGuardian"
     AND EXISTS (SELECT 1 FROM public."patient_responsible_parties" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept AND k."migratedFromGuardian");

  -- El mismo fichero subido a los dos: se anula la copia del absorbido (un
  -- documento solo se anula, DX-151); el del conservado sigue.
  UPDATE public."patient_documents" d
     SET "voidedAt" = v_now, "voidedById" = p_actor,
         "voidReason" = 'Duplicado: el mismo archivo ya está en el paciente que se conserva tras la fusión'
   WHERE d."tenantId" = v_tenant AND d."patientId" = p_absorbed AND d."voidedAt" IS NULL
     AND EXISTS (SELECT 1 FROM public."patient_documents" k
                  WHERE k."tenantId" = v_tenant AND k."patientId" = p_kept
                    AND k."sha256" = d."sha256" AND k."voidedAt" IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('documentsDuplicatedVoided', v_n); END IF;

  -- Recall del mismo tipo en los dos (uno por paciente y tipo): queda el del
  -- conservado; los contactos del otro pasan a él y el recall sobrante, ya
  -- sin contactos, se borra (es la programación, no un registro clínico).
  UPDATE public."recall_contacts" c
     SET "recallId" = kr."id"
    FROM public."patient_recalls" ar
    JOIN public."patient_recalls" kr
      ON kr."tenantId" = ar."tenantId" AND kr."patientId" = p_kept
     AND kr."recallTypeId" = ar."recallTypeId"
   WHERE ar."tenantId" = v_tenant AND ar."patientId" = p_absorbed
     AND c."tenantId" = v_tenant AND c."recallId" = ar."id";
  DELETE FROM public."patient_recalls" ar
   WHERE ar."tenantId" = v_tenant AND ar."patientId" = p_absorbed
     AND EXISTS (SELECT 1 FROM public."patient_recalls" kr
                  WHERE kr."tenantId" = v_tenant AND kr."patientId" = p_kept
                    AND kr."recallTypeId" = ar."recallTypeId");
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('recallsMerged', v_n); END IF;

  -- Anamnesis: una versión por número y paciente. Se apartan los números de
  -- los dos (fuera del rango en uso) y, tras mover, se renumeran por fecha:
  -- la vigente es la más reciente de las dos fichas. El contenido no cambia.
  UPDATE public."medical_history_versions" v
     SET "version" = v."version" + CASE WHEN v."patientId" = p_absorbed THEN 1000000 ELSE 2000000 END
   WHERE v."tenantId" = v_tenant AND v."patientId" IN (p_absorbed, p_kept) AND v."deletedAt" IS NULL;

  -- Resumen del consentimiento (deprecado, DX-037): el de la última fila
  -- GENERAL de los dos.
  SELECT pg_catalog.max(c."recordedAt") FILTER (WHERE c."patientId" = p_absorbed),
         pg_catalog.max(c."recordedAt") FILTER (WHERE c."patientId" = p_kept)
    INTO v_consent_absorbed, v_consent_kept
    FROM public."data_processing_consents" c
   WHERE c."tenantId" = v_tenant AND c."patientId" IN (p_absorbed, p_kept) AND c."scope" = 'GENERAL';

  -- La reasignación, en UNA sentencia: las FK compuestas (tenantId,
  -- patientId, id) con ON UPDATE RESTRICT entre tablas de la lista solo se
  -- comprueban al final de la sentencia, cuando padres e hijos ya apuntan al
  -- conservado. Cada UPDATE solo cambia la columna de paciente.
  FOR v_table IN
    SELECT DISTINCT pg_catalog.split_part(e, '.', 1)
      FROM pg_catalog.unnest(public.dx_patient_merge_tables()) AS e
     ORDER BY 1
  LOOP
    v_i := v_i + 1;
    IF v_table = 'patient_responsible_parties' THEN
      v_ctes := v_ctes || pg_catalog.format(
        'm%s AS (UPDATE public.%I t SET "patientId" = CASE WHEN t."patientId" = $2 THEN $3 ELSE t."patientId" END, '
        '"responsiblePatientId" = CASE WHEN t."responsiblePatientId" = $2 THEN $3 ELSE t."responsiblePatientId" END '
        'WHERE t."tenantId" = $1 AND (t."patientId" = $2 OR t."responsiblePatientId" = $2) '
        'AND NOT (t."patientId" IN ($2, $3) AND t."responsiblePatientId" IN ($2, $3)) RETURNING 1)',
        v_i, v_table);
    ELSE
      v_ctes := v_ctes || pg_catalog.format(
        'm%s AS (UPDATE public.%I t SET "patientId" = $3 WHERE t."tenantId" = $1 AND t."patientId" = $2 RETURNING 1)',
        v_i, v_table);
    END IF;
    v_counts := v_counts || pg_catalog.format(
      'pg_catalog.jsonb_build_object(%L, (SELECT pg_catalog.count(*) FROM m%s))', v_table, v_i);
  END LOOP;
  EXECUTE 'WITH ' || pg_catalog.array_to_string(v_ctes, ', ')
       || ' SELECT ' || pg_catalog.array_to_string(v_counts, ' || ')
    INTO v_moved
    USING v_tenant, p_absorbed, p_kept;
  SELECT COALESCE(pg_catalog.jsonb_object_agg(k, v ORDER BY k), '{}'::jsonb) INTO v_moved
    FROM pg_catalog.jsonb_each(v_moved) AS m(k, v)
   WHERE (v #>> '{}')::bigint > 0;

  UPDATE public."medical_history_versions" v
     SET "version" = r."rn"
    FROM (SELECT x."id",
                 (pg_catalog.row_number() OVER (ORDER BY x."createdAt", x."version", x."id"))::integer AS "rn"
            FROM public."medical_history_versions" x
           WHERE x."tenantId" = v_tenant AND x."patientId" = p_kept AND x."deletedAt" IS NULL) r
   WHERE v."tenantId" = v_tenant AND v."id" = r."id";

  -- «No es duplicado» del absorbido con un tercero vale para el conservado.
  INSERT INTO public."patient_duplicate_dismissals"
         ("id", "tenantId", "patientAId", "patientBId", "dismissedById", "createdAt")
  SELECT pg_catalog.gen_random_uuid(), v_tenant,
         LEAST(d."other", p_kept), GREATEST(d."other", p_kept), d."dismissedById", d."createdAt"
    FROM (SELECT CASE WHEN x."patientAId" = p_absorbed THEN x."patientBId" ELSE x."patientAId" END AS "other",
                 x."dismissedById", x."createdAt"
            FROM public."patient_duplicate_dismissals" x
           WHERE x."tenantId" = v_tenant AND p_absorbed IN (x."patientAId", x."patientBId")) d
   WHERE d."other" <> p_kept
  ON CONFLICT ("tenantId", "patientAId", "patientBId") DO NOTHING;
  DELETE FROM public."patient_duplicate_dismissals" x
   WHERE x."tenantId" = v_tenant AND p_absorbed IN (x."patientAId", x."patientBId");

  -- DX-172: captación. Quienes el absorbido recomendó pasan al conservado
  -- (salvo el propio conservado: nadie se recomienda a sí mismo, y su vínculo
  -- con el absorbido se vacía). Si el conservado no tenía fuente, hereda la
  -- del absorbido, sin un referente que sea uno de los dos.
  UPDATE public."patients" p
     SET "referredByPatientId" = p_kept
   WHERE p."tenantId" = v_tenant AND p."referredByPatientId" = p_absorbed AND p."id" <> p_kept;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('referralsMoved', v_n); END IF;
  UPDATE public."patients" p
     SET "referredByPatientId" = NULL
   WHERE p."tenantId" = v_tenant AND p."id" = p_kept AND p."referredByPatientId" = p_absorbed;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('selfReferralCleared', v_n); END IF;
  UPDATE public."patients" k
     SET "sourceId" = a."sourceId",
         "referredByPatientId" = CASE WHEN a."referredByPatientId" IN (p_absorbed, p_kept) THEN NULL
                                      ELSE a."referredByPatientId" END,
         "referredByName" = a."referredByName"
    FROM public."patients" a
   WHERE k."tenantId" = v_tenant AND k."id" = p_kept AND k."sourceId" IS NULL
     AND a."tenantId" = v_tenant AND a."id" = p_absorbed AND a."sourceId" IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('acquisitionInherited', v_n); END IF;

  -- Lo que ya apuntaba al absorbido (fusiones anteriores) apunta al
  -- conservado: un enlace viejo nunca acaba en un paciente retirado.
  UPDATE public."patients" p
     SET "mergedIntoId" = p_kept
   WHERE p."tenantId" = v_tenant AND p."mergedIntoId" = p_absorbed;

  UPDATE public."patients" p
     SET "deletedAt" = v_now, "mergedIntoId" = p_kept, "updatedAt" = v_now
   WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed;

  -- Retención legal (DX-039): el conservado guarda la HC de los dos, así que
  -- conserva lo más largo de cada dato (última atención, extensión, suelo).
  UPDATE public."patients" p
     SET "last_attention_at" = GREATEST(v_kept."last_attention_at", v_absorbed."last_attention_at"),
         "retention_extended" = CASE
           WHEN 'PERMANENT' IN (v_kept."retention_extended"::text, v_absorbed."retention_extended"::text) THEN 'PERMANENT'
           WHEN 'DOUBLE' IN (v_kept."retention_extended"::text, v_absorbed."retention_extended"::text) THEN 'DOUBLE'
           ELSE 'NONE' END::public."RetentionExtension",
         "retention_floor_until" = GREATEST(v_kept."retention_floor_until", v_absorbed."retention_floor_until"),
         "dataConsentAccepted" = CASE WHEN v_consent_absorbed > v_consent_kept OR (v_consent_kept IS NULL AND v_consent_absorbed IS NOT NULL)
                                      THEN v_absorbed."dataConsentAccepted" ELSE p."dataConsentAccepted" END,
         "dataConsentAt" = CASE WHEN v_consent_absorbed > v_consent_kept OR (v_consent_kept IS NULL AND v_consent_absorbed IS NOT NULL)
                                THEN v_absorbed."dataConsentAt" ELSE p."dataConsentAt" END,
         "dataConsentPolicyVersion" = CASE WHEN v_consent_absorbed > v_consent_kept OR (v_consent_kept IS NULL AND v_consent_absorbed IS NOT NULL)
                                           THEN v_absorbed."dataConsentPolicyVersion" ELSE p."dataConsentPolicyVersion" END,
         "updatedAt" = v_now
   WHERE p."tenantId" = v_tenant AND p."id" = p_kept;

  -- La cartera de los dos, recalculada ya con todo en el conservado.
  PERFORM public."patient_ledgers_refresh"(ARRAY[v_tenant, v_tenant], ARRAY[p_absorbed, p_kept]);

  PERFORM pg_catalog.set_config('dentalix.patient_merge', '', true);
  RETURN pg_catalog.jsonb_build_object('moved', v_moved, 'resolved', v_resolved);
END;
$$;

REVOKE ALL ON FUNCTION public.dx_merge_patients(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_merge_patients(uuid, uuid, uuid) TO dentalix_app;
