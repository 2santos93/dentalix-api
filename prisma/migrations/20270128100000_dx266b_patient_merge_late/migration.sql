-- DX-266-bis: volver a pasar al conservado lo que llegó tarde a un absorbido.
--
-- La ventana (riesgo residual de DX-266): una escritura para el absorbido que
-- valida al paciente justo antes de la fusión y confirma justo después (p. ej.
-- una cita creada en ese mismo segundo) se queda en el absorbido: la FK no
-- mira "deletedAt". En vez de cerrar la ventana en cada escritor (FOR SHARE
-- del paciente en todas las tablas con paciente, con riesgo de
-- interbloqueos), el ADMIN la repara: la ficha del conservado avisa de lo que
-- quedó en el absorbido y lo vuelve a pasar con la MISMA maquinaria.
--
-- Cambios:
--   dx_merge_patients_core(a, k, actor, late)  el cuerpo de la fusión: la
--                         definición vigente de dx_merge_patients (DX-172,
--                         20270117090000) sin cambios salvo el modo «tardío»
--                         (late = true):
--                           - el absorbido tiene que estar ya retirado con
--                             mergedIntoId (si no, DX266_NOT_MERGED), apuntar
--                             a este conservado y el conservado seguir vivo
--                             (si no, DX266_PATIENT_INACTIVE);
--                           - sin nada pendiente devuelve vacío sin tocar
--                             nada (idempotente);
--                           - no hereda la captación del absorbido ni vuelve a
--                             retirarlo (la ficha se decidió en la fusión);
--                           - el resto igual: bloqueo de los dos FOR UPDATE,
--                             bloqueos de negocio, «uno por
--                             paciente», la reasignación en una sentencia con
--                             la lista cerrada dx_patient_merge_tables(), los
--                             recomendados, la retención y la cartera.
--                         Sin EXECUTE para nadie: solo la llaman las dos de
--                         abajo (SECURITY DEFINER, mismo dueño). Para cambiar
--                         la fusión, CREATE OR REPLACE de ESTA función (unión
--                         completa sobre la última definición).
--   dx_merge_patients(a, k, actor)  la misma firma y el mismo contrato:
--                         llama a la de arriba con late = false. La puerta de
--                         las guardas sigue mirando a su dueño.
--   dx_merge_patients_late(a, actor)  la acción del ADMIN: late = true contra
--                         el conservado que marca mergedIntoId. Bloquea el
--                         conservado y DESPUÉS el absorbido: el orden en que
--                         los toma la fusión (su pareja y después, al
--                         reapuntar mergedIntoId, los absorbidos de los dos).
--   dx_patient_merge_pending(a)  lo que quedó en un absorbido, por tabla de la
--                         lista (y los recomendados, «patients»): solo
--                         recuentos, solo de un absorbido de la clínica de la
--                         sesión. Sin un absorbido, '{}'.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_merge_patients con la
-- definición de 20270117090000 y
--   DROP FUNCTION public.dx_merge_patients_late(uuid, uuid);
--   DROP FUNCTION public.dx_merge_patients_core(uuid, uuid, uuid, boolean);
--   DROP FUNCTION public.dx_patient_merge_pending(uuid);

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Lo que quedó en un absorbido
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dx_patient_merge_pending(p_absorbed uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  v_kept uuid;
  v_entry text;
  v_table text;
  v_column text;
  v_n bigint;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'DX266_NO_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p."mergedIntoId" INTO v_kept
    FROM public."patients" p
   WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed
     AND p."deletedAt" IS NOT NULL AND p."mergedIntoId" IS NOT NULL;
  IF v_kept IS NULL THEN
    RETURN v_out;
  END IF;
  FOREACH v_entry IN ARRAY public.dx_patient_merge_tables() LOOP
    v_table := pg_catalog.split_part(v_entry, '.', 1);
    v_column := pg_catalog.split_part(v_entry, '.', 2);
    -- El vínculo de responsable ENTRE los dos se queda, retirado, en el
    -- absorbido (la fusión no lo mueve): no es pendiente.
    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*) FROM public.%I t WHERE t."tenantId" = $1 AND t.%I = $2%s',
      v_table, v_column,
      CASE WHEN v_table = 'patient_responsible_parties'
           THEN ' AND NOT (t."patientId" IN ($2, $3) AND t."responsiblePatientId" IN ($2, $3))'
           ELSE '' END)
      INTO v_n USING v_tenant, p_absorbed, v_kept;
    IF v_n > 0 THEN
      v_out := v_out || pg_catalog.jsonb_build_object(
        v_table, COALESCE((v_out ->> v_table)::bigint, 0) + v_n);
    END IF;
  END LOOP;
  -- DX-172: quienes el absorbido recomendó (salvo el propio conservado).
  SELECT pg_catalog.count(*) INTO v_n
    FROM public."patients" p
   WHERE p."tenantId" = v_tenant AND p."referredByPatientId" = p_absorbed AND p."id" <> v_kept;
  IF v_n > 0 THEN
    v_out := v_out || pg_catalog.jsonb_build_object('patients', v_n);
  END IF;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.dx_patient_merge_pending(uuid) IS
  'DX-266-bis: filas que quedaron en un paciente absorbido, por tabla (solo recuentos). {} si no es un absorbido.';

REVOKE ALL ON FUNCTION public.dx_patient_merge_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_patient_merge_pending(uuid) TO dentalix_app;

-- ---------------------------------------------------------------------------
-- El cuerpo de la fusión (DX-266 + DX-172) con el modo tardío
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dx_merge_patients_core(p_absorbed uuid, p_kept uuid, p_actor uuid, p_late boolean)
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
  SELECT p."deletedAt", p."mergedIntoId", p."last_attention_at", p."retention_extended",
         p."retention_floor_until", p."dataConsentAccepted", p."dataConsentAt",
         p."dataConsentPolicyVersion"
    INTO v_absorbed
    FROM public."patients" p WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed;
  SELECT p."deletedAt", p."last_attention_at", p."retention_extended",
         p."retention_floor_until"
    INTO v_kept
    FROM public."patients" p WHERE p."tenantId" = v_tenant AND p."id" = p_kept;
  IF p_late THEN
    -- DX-266-bis: lo que llegó tarde a un absorbido. Solo de un absorbido YA
    -- fusionado en este conservado, que sigue vivo.
    IF v_absorbed."deletedAt" IS NULL OR v_absorbed."mergedIntoId" IS NULL THEN
      RAISE EXCEPTION 'DX266_NOT_MERGED' USING ERRCODE = 'DX266';
    END IF;
    -- Mientras esperaba, el conservado se fusionó con otro (o se archivó).
    IF v_absorbed."mergedIntoId" <> p_kept OR v_kept."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'DX266_PATIENT_INACTIVE' USING ERRCODE = 'DX266';
    END IF;
    -- Nada pendiente: no se toca nada (ni la anamnesis, ni la cartera).
    IF public.dx_patient_merge_pending(p_absorbed) = '{}'::jsonb THEN
      RETURN pg_catalog.jsonb_build_object('moved', '{}'::jsonb, 'resolved', '{}'::jsonb);
    END IF;
  -- Un archivado (o ya fusionado) no entra: se desarchiva antes, si procede.
  ELSIF v_absorbed."deletedAt" IS NOT NULL OR v_kept."deletedAt" IS NOT NULL THEN
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
  -- Al volver a pasar lo tardío (DX-266-bis), no: la ficha se decidió en la
  -- fusión.
  UPDATE public."patients" k
     SET "sourceId" = a."sourceId",
         "referredByPatientId" = CASE WHEN a."referredByPatientId" IN (p_absorbed, p_kept) THEN NULL
                                      ELSE a."referredByPatientId" END,
         "referredByName" = a."referredByName"
    FROM public."patients" a
   WHERE k."tenantId" = v_tenant AND k."id" = p_kept AND k."sourceId" IS NULL
     AND a."tenantId" = v_tenant AND a."id" = p_absorbed AND a."sourceId" IS NOT NULL
     AND NOT p_late;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_resolved := v_resolved || pg_catalog.jsonb_build_object('acquisitionInherited', v_n); END IF;

  -- Lo que ya apuntaba al absorbido (fusiones anteriores) apunta al
  -- conservado: un enlace viejo nunca acaba en un paciente retirado.
  UPDATE public."patients" p
     SET "mergedIntoId" = p_kept
   WHERE p."tenantId" = v_tenant AND p."mergedIntoId" = p_absorbed;

  -- Al volver a pasar lo tardío, el absorbido ya está retirado: se queda con
  -- la fecha de su fusión.
  UPDATE public."patients" p
     SET "deletedAt" = v_now, "mergedIntoId" = p_kept, "updatedAt" = v_now
   WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed AND NOT p_late;

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
COMMENT ON FUNCTION public.dx_merge_patients_core(uuid, uuid, uuid, boolean) IS
  'DX-266/DX-266-bis: el cuerpo de la fusión. Solo la llaman dx_merge_patients y dx_merge_patients_late.';

REVOKE ALL ON FUNCTION public.dx_merge_patients_core(uuid, uuid, uuid, boolean) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Las dos entradas
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dx_merge_patients(p_absorbed uuid, p_kept uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN public.dx_merge_patients_core(p_absorbed, p_kept, p_actor, false);
END;
$$;

REVOKE ALL ON FUNCTION public.dx_merge_patients(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_merge_patients(uuid, uuid, uuid) TO dentalix_app;

CREATE FUNCTION public.dx_merge_patients_late(p_absorbed uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  v_kept uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'DX266_NO_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p."mergedIntoId" INTO v_kept
    FROM public."patients" p WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DX266_NOT_FOUND' USING ERRCODE = 'DX266';
  END IF;
  IF v_kept IS NULL THEN
    RAISE EXCEPTION 'DX266_NOT_MERGED' USING ERRCODE = 'DX266';
  END IF;
  -- Orden de bloqueo: el conservado y DESPUÉS el absorbido, el mismo que la
  -- fusión. Una fusión bloquea a su pareja (en orden de id) y después, al
  -- reapuntar "mergedIntoId", a los absorbidos de los dos: un absorbido
  -- siempre después de su conservado. Así, «volver a pasar» y una fusión del
  -- conservado con un tercero a la vez se ponen en cola (sin interbloqueo).
  -- El cuerpo vuelve a bloquear a los dos (ya son suyos: no espera) y
  -- comprueba que el absorbido sigue apuntando a este conservado.
  PERFORM 1 FROM public."patients" p
    WHERE p."tenantId" = v_tenant AND p."id" = v_kept FOR UPDATE OF p;
  PERFORM 1 FROM public."patients" p
    WHERE p."tenantId" = v_tenant AND p."id" = p_absorbed FOR UPDATE OF p;
  RETURN public.dx_merge_patients_core(p_absorbed, v_kept, p_actor, true);
END;
$$;

COMMENT ON FUNCTION public.dx_merge_patients_late(uuid, uuid) IS
  'DX-266-bis: vuelve a pasar al conservado lo que llegó tarde a un absorbido. Idempotente.';

REVOKE ALL ON FUNCTION public.dx_merge_patients_late(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_merge_patients_late(uuid, uuid) TO dentalix_app;
