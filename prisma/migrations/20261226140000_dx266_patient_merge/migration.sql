-- DX-266: pacientes posiblemente duplicados y fusión segura.
--
--   patients."mergedIntoId"         el paciente absorbido apunta al que se
--                                   conserva (FK compuesta por clínica). Un
--                                   absorbido siempre está retirado
--                                   ("deletedAt") y nunca apunta a sí mismo
--                                   (CHECK). FK y CHECK NOT VALID: se validan
--                                   en 20261226140100 (la columna nace NULL).
--   patient_duplicate_dismissals    «No es duplicado»: la pareja descartada
--                                   (A < B), con quién y cuándo. RLS FORCE,
--                                   FK compuestas a patients y FK directa a
--                                   tenants con RESTRICT. La app solo lee e
--                                   inserta (append-only, DX-148).
--   dx_patient_merge_tables()       lista CERRADA de las columnas que la
--                                   fusión reasigna (test/patient-merge.int-
--                                   spec.ts la compara con el catálogo).
--   dx_patient_merge_active/_gate() la puerta de las guardas: dentro de la
--                                   fusión, y solo como el dueño de
--                                   dx_merge_patients, una fila puede cambiar
--                                   SOLO su paciente del absorbido al que se
--                                   conserva (y, en dos tablas, el número de
--                                   versión de la anamnesis o el recall del
--                                   contacto). El contenido no cambia.
--   dx_patient_merge_blockers(a, b) lo que impide fusionar y resuelve la
--                                   clínica (citas que se solapan, saldos
--                                   migrados del mismo lote, dos compromisos
--                                   de pago abiertos); lo enseña la vista
--                                   previa y lo comprueba la fusión.
--   dx_merge_patients(a, k, actor)  SECURITY DEFINER con search_path fijo: la
--                                   app (sin UPDATE en las tablas append-only)
--                                   no puede reasignar nada por su cuenta; la
--                                   función bloquea los dos pacientes, rechaza
--                                   lo que no se puede fusionar, resuelve los
--                                   únicos «uno por paciente», reasigna todas
--                                   las filas en UNA sentencia y devuelve lo
--                                   movido por tabla (para la auditoría).
--   52 funciones de guarda          CREATE OR REPLACE idéntico al de main con
--                                   la puerta como primera instrucción.
--
-- Solo AÑADE: una columna nullable sin DEFAULT (no reescribe patients), una
-- tabla vacía y funciones. El código anterior no las conoce: las guardas sin
-- la variable de la fusión se comportan exactamente igual que antes.
--
-- Vuelta atrás: desplegar la API anterior, volver a crear las 52 guardas con
-- su definición de la migración que las creó (o la de main) y
--   DROP FUNCTION public.dx_merge_patients(uuid, uuid, uuid);
--   DROP FUNCTION public.dx_patient_merge_blockers(uuid, uuid);
--   DROP FUNCTION public.dx_patient_merge_gate(name, jsonb, jsonb);
--   DROP FUNCTION public.dx_patient_merge_active();
--   DROP FUNCTION public.dx_patient_merge_tables();
--   DROP TABLE public."patient_duplicate_dismissals";
--   ALTER TABLE public."patients" DROP COLUMN "mergedIntoId";
-- (las fusiones hechas no se deshacen: sus filas siguen en el conservado).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- patients."mergedIntoId"
-- ---------------------------------------------------------------------------

ALTER TABLE "patients" ADD COLUMN "mergedIntoId" UUID;

ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_fkey"
  FOREIGN KEY ("tenantId", "mergedIntoId") REFERENCES "patients"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_check"
  CHECK ("mergedIntoId" IS NULL OR ("mergedIntoId" <> "id" AND "deletedAt" IS NOT NULL))
  NOT VALID;

-- ---------------------------------------------------------------------------
-- «No es duplicado»
-- ---------------------------------------------------------------------------

CREATE TABLE "patient_duplicate_dismissals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientAId" UUID NOT NULL,
    "patientBId" UUID NOT NULL,
    "dismissedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_duplicate_dismissals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_duplicate_dismissals_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_duplicate_dismissals_patient_a_fkey"
      FOREIGN KEY ("tenantId", "patientAId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_duplicate_dismissals_patient_b_fkey"
      FOREIGN KEY ("tenantId", "patientBId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La pareja va siempre ordenada: (A, B) y (B, A) son la misma.
    CONSTRAINT "patient_duplicate_dismissals_order_check" CHECK ("patientAId" < "patientBId")
);

CREATE UNIQUE INDEX "patient_duplicate_dismissals_pair_key"
  ON "patient_duplicate_dismissals"("tenantId", "patientAId", "patientBId");
-- Lado hijo de la FK del segundo paciente (el primero lo sirve el único).
CREATE INDEX "patient_duplicate_dismissals_patient_b_idx"
  ON "patient_duplicate_dismissals"("tenantId", "patientBId");

ALTER TABLE "patient_duplicate_dismissals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_duplicate_dismissals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_duplicate_dismissals"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON "patient_duplicate_dismissals" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_duplicate_dismissals" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Lo que la fusión reasigna
-- ---------------------------------------------------------------------------

-- Lista CERRADA ("tabla.columna"): una tabla nueva con paciente no se mueve
-- sola. test/patient-merge.int-spec.ts falla si el catálogo tiene una columna
-- de paciente que no está aquí ni en su lista de exclusiones razonadas.
CREATE FUNCTION public.dx_patient_merge_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY[
    'anesthesia_administrations.patientId',
    'appointment_plan_items.patientId',
    'appointment_reserved_overrides.patientId',
    'appointment_status_reversals.patientId',
    'appointment_waitlist.patientId',
    'appointments.patientId',
    'cancellation_fees.patientId',
    'clinical_entries.patientId',
    'clinical_entry_addenda.patientId',
    'clinical_entry_diagnoses.patientId',
    'clinical_record_copies.patientId',
    'closing_queue_dismissals.patientId',
    'collection_notes.patientId',
    'data_processing_consents.patientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'opening_balances.patientId',
    'patient_agreements.patientId',
    'patient_certificate_copy_links.patientId',
    'patient_certificates.patientId',
    'patient_consent_countersignatures.patientId',
    'patient_consents.patientId',
    'patient_coverages.patientId',
    'patient_credit_entries.patientId',
    'patient_credit_refunds.patientId',
    'patient_credit_transfers.patientId',
    'patient_dentition_events.patientId',
    'patient_documents.patientId',
    'patient_implants.patientId',
    'patient_majority_reviews.patientId',
    'patient_recalls.patientId',
    'patient_responsible_parties.patientId',
    'patient_responsible_parties.responsiblePatientId',
    'patient_retention_actions.patientId',
    'payment_links.patientId',
    'payment_plans.patientId',
    'payment_promises.patientId',
    'payment_reports.patientId',
    'payments.patientId',
    'perio_exams.patientId',
    'post_op_instruction_deliveries.patientId',
    'prescription_copy_links.patientId',
    'prescriptions.patientId',
    'recall_contacts.patientId',
    'reminder_opt_out_links.patientId',
    'reminder_opt_out_match_warnings.patientId',
    'sedation_records.patientId',
    'signature_requests.patientId',
    'signed_consent_pdf_links.patientId',
    'signed_consent_pdfs.patientId',
    'tooth_records.patientId',
    'treatment_plan_acceptances.patientId',
    'treatment_plan_items.patientId',
    'treatment_plan_repricings.patientId',
    'treatment_plans.patientId',
    'waitlist_offers.patientId'
  ]::text[]
$$;

-- ¿Hay una fusión en curso en esta transacción? Barato: lo primero que mira
-- cada guarda antes de calcular nada.
CREATE FUNCTION public.dx_patient_merge_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(pg_catalog.current_setting('dentalix.patient_merge', true), '') <> ''
$$;

-- La puerta. Verdadero SOLO si:
--   1. corre como el dueño de dx_merge_patients (la app nunca lo es: aunque
--      fije la variable, aquí da falso), dentro de esa función, que fija
--      'dentalix.patient_merge' = '<clínica>:<absorbido>:<conservado>' solo
--      para su transacción;
--   2. la tabla está en dx_patient_merge_tables() y la fila es de esa clínica;
--   3. no cambia NADA salvo las columnas de paciente de la lista (y cada una
--      o no cambia o pasa del absorbido al conservado) y, solo con el
--      paciente de la pareja, el número de versión de la anamnesis
--      (medical_history_versions.version, que la fusión renumera por fecha) o
--      el recall de un contacto (recall_contacts.recallId, cuando los dos
--      tenían un recall del mismo tipo).
CREATE FUNCTION public.dx_patient_merge_gate(p_table name, p_old jsonb, p_new jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_parts text[] := pg_catalog.string_to_array(
    COALESCE(pg_catalog.current_setting('dentalix.patient_merge', true), ''), ':');
  v_owner name;
  v_patient_cols text[];
  v_extra_cols text[] := ARRAY[]::text[];
  v_generated text[];
  v_col text;
BEGIN
  IF pg_catalog.cardinality(v_parts) <> 3 THEN
    RETURN false;
  END IF;
  SELECT r.rolname INTO v_owner
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
   WHERE p.oid = 'public.dx_merge_patients(uuid, uuid, uuid)'::pg_catalog.regprocedure;
  IF v_owner IS NULL OR current_user <> v_owner THEN
    RETURN false;
  END IF;
  IF p_old ->> 'tenantId' IS DISTINCT FROM v_parts[1] THEN
    RETURN false;
  END IF;
  SELECT pg_catalog.array_agg(pg_catalog.split_part(e, '.', 2)) INTO v_patient_cols
    FROM pg_catalog.unnest(public.dx_patient_merge_tables()) AS e
   WHERE pg_catalog.split_part(e, '.', 1) = p_table;
  IF v_patient_cols IS NULL THEN
    RETURN false;
  END IF;
  IF p_table = 'medical_history_versions' THEN
    v_extra_cols := ARRAY['version'];
  ELSIF p_table = 'recall_contacts' THEN
    v_extra_cols := ARRAY['recallId'];
  END IF;
  -- Las columnas generadas llegan a NULL en NEW dentro de un BEFORE (DX-225):
  -- se calculan solas y nadie las escribe; no cuentan.
  SELECT COALESCE(pg_catalog.array_agg(a.attname::text), ARRAY[]::text[]) INTO v_generated
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.format('public.%I', p_table)::pg_catalog.regclass
     AND a.attgenerated <> '' AND NOT a.attisdropped;
  IF (p_old - (v_patient_cols || v_extra_cols || v_generated))
       IS DISTINCT FROM (p_new - (v_patient_cols || v_extra_cols || v_generated)) THEN
    RETURN false;
  END IF;
  FOREACH v_col IN ARRAY v_patient_cols LOOP
    IF p_old ->> v_col IS DISTINCT FROM p_new ->> v_col
       AND NOT (p_old ->> v_col = v_parts[2] AND p_new ->> v_col = v_parts[3]) THEN
      RETURN false;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY v_extra_cols LOOP
    IF p_old ->> v_col IS DISTINCT FROM p_new ->> v_col
       AND NOT (p_old ->> 'patientId' IN (v_parts[2], v_parts[3])) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- EXECUTE de PUBLIC (el de siempre): las guardas corren como quien escribe
-- (la app, el owner o cualquier rol de servicio) y todas tienen que poder
-- preguntar. Solo leen y a cualquiera que no sea el dueño le dicen que no.

-- ---------------------------------------------------------------------------
-- La fusión
-- ---------------------------------------------------------------------------

-- Lo que impide fusionar a dos pacientes y la clínica tiene que resolver
-- antes (simétrico: no depende de cuál se conserva). Lo usan la fusión y su
-- vista previa (como la app, con RLS: solo ve su clínica). Códigos:
--   DX266_OVERLAPPING_APPOINTMENTS  dos citas vivas que se solapan
--                                   (appointments_no_overlap_per_patient);
--   DX266_OPENING_BALANCE_CONFLICT  saldos migrados del mismo lote y moneda
--                                   (uno por paciente, lote y moneda; son
--                                   importes inalterables con abonos propios);
--   DX266_OPEN_PAYMENT_PROMISES     dos compromisos de pago abiertos (uno
--                                   abierto por paciente).
CREATE FUNCTION public.dx_patient_merge_blockers(p_a uuid, p_b uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.array_remove(ARRAY[
    CASE WHEN EXISTS (
      SELECT 1
        FROM public."appointments" x
        JOIN public."appointments" y
          ON y."tenantId" = x."tenantId" AND y."patientId" = p_b
         AND y."deletedAt" IS NULL AND y."status" <> 'CANCELLED'
         AND pg_catalog.tsrange(x."start", x."end") OPERATOR(pg_catalog.&&) pg_catalog.tsrange(y."start", y."end")
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a AND x."deletedAt" IS NULL AND x."status" <> 'CANCELLED'
    ) THEN 'DX266_OVERLAPPING_APPOINTMENTS' END,
    CASE WHEN EXISTS (
      SELECT 1
        FROM public."opening_balances" x
        JOIN public."opening_balances" y
          ON y."tenantId" = x."tenantId" AND y."patientId" = p_b
         AND y."importBatchId" = x."importBatchId" AND y."currency" = x."currency"
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a
    ) THEN 'DX266_OPENING_BALANCE_CONFLICT' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public."payment_promises" x
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a AND x."status" = 'OPEN'
    ) AND EXISTS (
      SELECT 1 FROM public."payment_promises" y
       WHERE y."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND y."patientId" = p_b AND y."status" = 'OPEN'
    ) THEN 'DX266_OPEN_PAYMENT_PROMISES' END
  ]::text[], NULL)
$$;

REVOKE ALL ON FUNCTION public.dx_patient_merge_blockers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_patient_merge_blockers(uuid, uuid) TO dentalix_app;

-- Fusiona p_absorbed en p_kept dentro de la transacción de quien llama (la de
-- la API: misma transacción que la auditoría y los enlaces anulados). La
-- clínica sale de app.current_tenant, nunca de un parámetro: dos pacientes de
-- clínicas distintas no se ven a la vez (DX266_NOT_FOUND). Errores con
-- SQLSTATE 'DX266' y el código en el mensaje; la API los traduce a 404/409.
CREATE FUNCTION public.dx_merge_patients(p_absorbed uuid, p_kept uuid, p_actor uuid)
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

-- ---------------------------------------------------------------------------
-- Las guardas, con la puerta (definición de main + las 7 líneas de DX-266)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.appointment_reserved_overrides_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-446)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.appointments_completed_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Una cita que nace atendida (importaciones, pruebas) no tiene salida.
    NEW."completedAt" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF OLD."status" IS DISTINCT FROM 'COMPLETED' THEN
      NEW."completedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    ELSE
      NEW."completedAt" := OLD."completedAt";
    END IF;
  ELSE
    NEW."completedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancellation_fees_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cancellation_fees es la prueba de lo cobrado o condonado: no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'el cargo ya está anulado: su anulación no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."voidedAt" IS NULL
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['voidedAt', 'voidedById', 'voidReason'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['voidedAt', 'voidedById', 'voidReason']) THEN
    RAISE EXCEPTION 'un cargo por cancelación solo se actualiza para anularlo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clinical_record_copies_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-456)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.closing_queue_dismissals_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-439)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx256_link_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
 -- INSERT/FK reassignment must observe status after a concurrent reactivation.
 -- Housekeeping UPDATE(active) never locks the parent: appointment sync already
 -- owns it, and locking from an existing child would invert parent -> child.
 IF TG_OP='INSERT' OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."patientId" IS DISTINCT FROM OLD."patientId" THEN
  PERFORM 1 FROM public.appointments a WHERE a.id=NEW."appointmentId"
   AND a."tenantId"=NEW."tenantId" AND a."patientId"=NEW."patientId" FOR SHARE;
 END IF;
 SELECT NEW."deletedAt" IS NULL AND a."deletedAt" IS NULL AND a.status IN ('SCHEDULED','CONFIRMED','ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')
  AND (a.start>=timezone('UTC', now()) OR a.status IN ('ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')) INTO NEW.active
 FROM public.appointments a WHERE a.id=NEW."appointmentId" AND a."tenantId"=NEW."tenantId" AND a."patientId"=NEW."patientId";
 NEW.active:=coalesce(NEW.active,false);
 IF NEW.active THEN
  -- Se libera por el estado REAL de la cita, también si el reloj hizo vencer
  -- la reserva sin que nadie actualizara su fila. El índice único arbitra las
  -- dos transacciones concurrentes tras esta limpieza.
  UPDATE public.appointment_plan_items link SET active=false FROM public.appointments a
   WHERE link."tenantId"=NEW."tenantId" AND link."planItemId"=NEW."planItemId" AND link.active
    AND link."appointmentId"<>NEW."appointmentId" AND a.id=link."appointmentId"
    AND (a."deletedAt" IS NOT NULL OR a.status IN ('CANCELLED','COMPLETED','NO_SHOW') OR (a.start<timezone('UTC', now()) AND a.status IN ('SCHEDULED','CONFIRMED')));
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.dx256_visits_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE plan_status text;
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
 IF TG_TABLE_NAME='treatment_plans' THEN
  IF NEW."visitIntervals" IS DISTINCT FROM OLD."visitIntervals" AND OLD.status NOT IN ('DRAFT','PRESENTED','ACCEPTED') THEN RAISE EXCEPTION 'El plan está cerrado: no se pueden cambiar sus visitas.' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.status='ACCEPTED' AND OLD.status<>'ACCEPTED' AND NEW."acceptedAt" IS NULL THEN
   NEW."acceptedAt":=timezone('UTC', now());
   NEW."acceptedLocationId":=coalesce(NEW."acceptedLocationId",NEW."presentedLocationId",(SELECT l.id FROM public.locations l WHERE l."tenantId"=NEW."tenantId" AND l."deletedAt" IS NULL ORDER BY l."createdAt",l.id LIMIT 1));
  END IF;
 ELSE
  IF NEW.visit IS DISTINCT FROM OLD.visit OR NEW."visitLabel" IS DISTINCT FROM OLD."visitLabel" THEN
   SELECT p.status INTO plan_status FROM public.treatment_plans p WHERE p.id=NEW."planId" FOR SHARE;
   IF plan_status NOT IN ('DRAFT','PRESENTED','ACCEPTED') THEN RAISE EXCEPTION 'El plan está cerrado: no se pueden cambiar sus visitas.' USING ERRCODE='restrict_violation'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.dx271_completed_link_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
 IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND EXISTS (
   SELECT 1 FROM public.appointments a
    WHERE a.id=OLD."appointmentId" AND a."tenantId"=OLD."tenantId"
      AND a.status='COMPLETED') THEN
  RAISE EXCEPTION 'Esta cita ya pasó: sus tratamientos no se cambian.'
   USING ERRCODE='Q0271';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.dx509_walk_in_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW."idempotencyKey", NEW."idempotencyFingerprint")
     IS DISTINCT FROM (OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'La clave de idempotencia de una cita se fija al crearla y no cambia (DX-510)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."overbooked" AND NOT OLD."overbooked" THEN
    RAISE EXCEPTION 'Un sobrecupo solo nace en «Atender sin cita» (DX-509)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."overbooked" AND NEW."overbooked"
     AND (NEW."start", NEW."end", NEW."providerId")
         IS DISTINCT FROM (OLD."start", OLD."end", OLD."providerId")
  THEN
    NEW."overbooked" := false;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_collection_note_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- La fecha de la gestión la pone el servidor de BD, en UTC (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'collection_notes es inalterable: una gestión no se edita ni se borra; una corrección es otra nota (DX-150)'
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_forbid_audit_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-009)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_forbid_clinical_record_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es inalterable: no se permite % en la historia clínica; para corregir se añade una adenda (DX-038)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_forbid_consent_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-037)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_forbid_odontogram_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % en el odontograma; para corregir un registro se anula con motivo (DX-120)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_patient_documents_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  void_columns CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_documents es inalterable: no se permite % de un documento del paciente; para corregirlo se anula con motivo (DX-151)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
  THEN
    RAISE EXCEPTION 'patient_documents es inalterable: un documento del paciente solo se anula, una vez (DX-151)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_patient_implants_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  void_columns CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
  card_columns CONSTANT text[] := ARRAY['cardDeliveredAt', 'cardDeliveredById'];
  -- Generadas: NULL en NEW dentro de un trigger BEFORE (DX-225).
  generated_columns CONSTANT text[] := ARRAY['lotKey', 'referenceKey'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_implants es inalterable: no se permite % de un implante registrado; para corregirlo se anula con motivo (DX-191)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns - card_columns - generated_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns - card_columns - generated_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
     OR (OLD."cardDeliveredAt" IS NOT NULL AND (
           NEW."cardDeliveredAt" IS DISTINCT FROM OLD."cardDeliveredAt"
           OR NEW."cardDeliveredById" IS DISTINCT FROM OLD."cardDeliveredById"))
  THEN
    RAISE EXCEPTION 'patient_implants es inalterable: un implante registrado solo se anula (una vez) o se marca su tarjeta como entregada (DX-191)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_patient_recalls_compat_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_seeded boolean := false;
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."recallTypeId" IS NULL AND NEW."kind" IS NOT NULL THEN
    SELECT rt."id" INTO NEW."recallTypeId"
      FROM public."recall_types" rt
     WHERE rt."tenantId" = NEW."tenantId"
       AND rt."systemKey" = NEW."kind";
    IF NEW."recallTypeId" IS NULL THEN
      v_seeded := public.dx_recall_ensure_default_types(NEW."tenantId");
      SELECT rt."id" INTO NEW."recallTypeId"
        FROM public."recall_types" rt
       WHERE rt."tenantId" = NEW."tenantId"
         AND rt."systemKey" = NEW."kind";
    END IF;
    IF TG_OP = 'INSERT' AND NEW."recallTypeId" IS NOT NULL AND NOT v_seeded THEN
      NEW."manualDoneAt" := coalesce(NEW."manualDoneAt", NEW."lastDoneAt");
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."recallTypeId" IS NOT NULL
     AND NEW."lastDoneAt" IS DISTINCT FROM OLD."lastDoneAt"
     AND NEW."manualDoneAt" IS NOT DISTINCT FROM OLD."manualDoneAt"
     AND coalesce(pg_catalog.current_setting('dentalix.recall_recompute', true), '') <> 'on' THEN
    NEW."manualDoneAt" := NEW."lastDoneAt";
    NEW."preBackfillDoneAt" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_payment_cash_session_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."cashSessionId" IS DISTINCT FROM OLD."cashSessionId" THEN
      RAISE EXCEPTION 'La caja de un abono no cambia (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."cashSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."cashSessionId"
       AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Un abono solo entra en una caja abierta de su sede (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_payment_promise_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_promises no admite %: un compromiso no se borra (DX-150)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Misma fuente de hora que el alta del abono (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    NEW."reopenedAt" := NULL;
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'Un compromiso nace abierto (DX-150)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: nada más que el estado, su hora de cierre y (al reabrir) la de
  -- reapertura.
  IF (NEW."id", NEW."tenantId", NEW."patientId", NEW."locationId", NEW."amount",
      NEW."currency", NEW."dueDate", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."patientId", OLD."locationId", OLD."amount",
      OLD."currency", OLD."dueDate", OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez (DX-150)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- OPEN -> KEPT | BROKEN (DX-150), sin tocar la reapertura.
  IF OLD."status" = 'OPEN' AND NEW."status" IN ('KEPT', 'BROKEN')
     AND NEW."reopenedAt" IS NOT DISTINCT FROM OLD."reopenedAt"
  THEN
    RETURN NEW;
  END IF;

  -- KEPT -> OPEN | BROKEN (DX-215): solo en la transacción que anula un abono
  -- que contaba para él.
  IF OLD."status" = 'KEPT' AND NEW."status" IN ('OPEN', 'BROKEN')
     AND EXISTS (
       SELECT 1
         FROM public."payments" p
        WHERE p."tenantId" = OLD."tenantId"
          AND p."patientId" = OLD."patientId"
          AND p."currency" = OLD."currency"
          AND p."voidedAt" IS NOT NULL
          AND p."deletedAt" IS NOT NULL
          AND p."createdAt" >= OLD."createdAt"
          -- SEC-042: el abono existía antes de ESTA transacción (su alta la
          -- pone la BD con el inicio de la transacción, DX-226, y "createdAt"
          -- ya no cambia): uno insertado y anulado aquí mismo no cuenta.
          AND p."createdAt" < pg_catalog.timezone('UTC', pg_catalog.now())::pg_catalog.timestamp(3)
          AND p.xmin = pg_catalog.pg_current_xact_id()::xid
     )
  THEN
    -- Hora del servidor en UTC, sea cual sea la zona de la sesión (DX-226).
    NEW."reopenedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez; uno cumplido solo se reabre al anular el abono que lo cumplía (DX-150, DX-215)'
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_payment_split_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  head_split uuid;
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Suelto, o la línea 1 (splitId = id, payments_split_check): nada que
    -- comprobar aquí.
    IF NEW."splitId" IS NULL OR NEW."splitId" = NEW."id" THEN
      RETURN NEW;
    END IF;
    -- FOR SHARE choca con el FOR NO KEY UPDATE de la anulación de la línea 1.
    SELECT h."splitId" INTO head_split
      FROM public."payments" h
     WHERE h."tenantId" = NEW."tenantId" AND h."id" = NEW."splitId"
       FOR SHARE;
    -- Sin fila visible no decide (la FK y el diferido, al COMMIT).
    IF FOUND AND head_split IS DISTINCT FROM NEW."splitId" THEN
      RAISE EXCEPTION 'Una línea de un cobro dividido apunta a su línea 1, no a un abono suelto ni a otra línea (DX-426)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (OLD."splitId" IS NOT NULL OR NEW."splitId" IS NOT NULL)
     AND (NEW."tenantId", NEW."patientId", NEW."locationId", NEW."splitId", NEW."splitLine")
         IS DISTINCT FROM
         (OLD."tenantId", OLD."patientId", OLD."locationId", OLD."splitId", OLD."splitLine")
  THEN
    RAISE EXCEPTION 'Una línea de un cobro dividido no cambia de paciente, sede ni cobro (DX-426)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_payment_void_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF public.dx_cash_is_superuser() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL OR NEW."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un abono no puede registrarse ya como abono anulado: nace vigente y solo se anula después (SEC-042)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."voidedAt" IS NOT NULL OR OLD."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un abono anulado es definitivo: no se puede modificar ni borrar (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'La fecha de alta de un abono no cambia (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Anulación: solo la marca de anulación; el resto del abono queda igual.
  IF (NEW."voidedAt" IS NOT NULL OR NEW."deletedAt" IS NOT NULL)
     AND (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-)
            ARRAY['deletedAt', 'voidedAt', 'voidedById', 'voidReason', 'updatedAt'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-)
            ARRAY['deletedAt', 'voidedAt', 'voidedById', 'voidReason', 'updatedAt'])
  THEN
    RAISE EXCEPTION 'Al anular un abono solo se escribe la anulación: importe, moneda y fechas no cambian (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_phone_e164_stale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."phone" IS DISTINCT FROM OLD."phone" THEN
    NEW."phoneE164" := NULL;
    NEW."phoneE164CheckedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_recall_contact_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- La fecha del contacto la pone el servidor de BD, en UTC (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'recall_contacts es inalterable: un contacto no se edita ni se borra; una corrección es otro contacto (DX-015)'
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.dx_recall_visit_location_on_recall()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF coalesce(pg_catalog.current_setting('dentalix.recall_visit_refresh', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId" THEN
    NEW."visitLocationId" := OLD."visitLocationId";
  ELSE
    NEW."visitLocationId" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.medical_history_submissions_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF OLD."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
     OR (OLD."answers" IS NOT NULL
         AND NEW."answers" IS DISTINCT FROM OLD."answers")
     OR (OLD."openedAt" IS NOT NULL
         AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."questionnaireVersion" IS DISTINCT FROM OLD."questionnaireVersion"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'medical_history_submissions: un envío revisado o caducado no cambia, y sus respuestas no se reescriben (DX-099)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.opening_balances_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(pg_catalog.current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'opening_balances: un saldo migrado no se borra; se retira (voidedAt)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."locationId", NEW."patientId", NEW."importBatchId",
         NEW."currency", NEW."amount", NEW."asOfDate", NEW."asOfDateApproximate",
         NEW."concept", NEW."sourceRows", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."locationId", OLD."patientId", OLD."importBatchId",
         OLD."currency", OLD."amount", OLD."asOfDate", OLD."asOfDateApproximate",
         OLD."concept", OLD."sourceRows", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'opening_balances: un saldo migrado no se modifica; solo se retira una vez'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.patient_certificate_copy_links_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_certificate_copy_links: no se borra un enlace de la copia del certificado (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'patient_certificate_copy_links: un enlace invalidado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."certificateId" IS DISTINCT FROM OLD."certificateId"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'patient_certificate_copy_links: solo se marca invalidado (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.patient_certificates_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_certificates: un certificado no se borra, se anula (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."professionalMembershipId" IS DISTINCT FROM OLD."professionalMembershipId"
     OR NEW."issuedById" IS DISTINCT FROM OLD."issuedById"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."attendedFrom" IS DISTINCT FROM OLD."attendedFrom"
     OR NEW."attendedUntil" IS DISTINCT FROM OLD."attendedUntil"
     OR NEW."timesSource" IS DISTINCT FROM OLD."timesSource"
     OR NEW."restDays" IS DISTINCT FROM OLD."restDays"
     OR NEW."restStartDate" IS DISTINCT FROM OLD."restStartDate"
     OR NEW."restEndDate" IS DISTINCT FROM OLD."restEndDate"
     OR NEW."diagnosis" IS DISTINCT FROM OLD."diagnosis"
     OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'patient_certificates: el contenido de un certificado emitido no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."documentId" IS NOT NULL
     AND NEW."documentId" IS DISTINCT FROM OLD."documentId" THEN
    RAISE EXCEPTION 'patient_certificates: el PDF archivado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedAt" IS NOT NULL AND (
       NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
       OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
    RAISE EXCEPTION 'patient_certificates: un certificado anulado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedDocumentId" IS NOT NULL
     AND NEW."voidedDocumentId" IS DISTINCT FROM OLD."voidedDocumentId" THEN
    RAISE EXCEPTION 'patient_certificates: el PDF anulado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.patient_consents_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'patient_consents es inmutable: un consentimiento firmado no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'patient_consents es inmutable: un consentimiento firmado no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.patient_credit_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro contable: no admite % (DX-253)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.payment_links_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_links: no se borra un enlace de pago (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_links: un enlace usado o anulado no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId"
     OR NEW."openingBalanceId" IS DISTINCT FROM OLD."openingBalanceId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."concept" IS DISTINCT FROM OLD."concept"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment_links: lo que pide el enlace no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- La apertura solo se marca una vez (OLD no estaba usado ni anulado, así
  -- que usedAt y revokedAt pasan, como mucho, de NULL a valor).
  IF OLD."openedAt" IS NOT NULL
     AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'payment_links: la apertura no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."proofUploadsIssued" < OLD."proofUploadsIssued" THEN
    RAISE EXCEPTION 'payment_links: las subidas autorizadas no se devuelven (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payment_reports_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_reports: no se borra un reporte de pago (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'payment_reports: un reporte decidido no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" NOT IN ('CONFIRMED', 'REJECTED') THEN
    RAISE EXCEPTION 'payment_reports: un reporte pendiente solo se confirma o se rechaza (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."linkId" IS DISTINCT FROM OLD."linkId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."paymentMethodId" IS DISTINCT FROM OLD."paymentMethodId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."proofUploadId" IS DISTINCT FROM OLD."proofUploadId"
     OR NEW."proofKey" IS DISTINCT FROM OLD."proofKey"
     OR NEW."proofMime" IS DISTINCT FROM OLD."proofMime"
     OR NEW."proofSize" IS DISTINCT FROM OLD."proofSize"
     OR NEW."proofSha256" IS DISTINCT FROM OLD."proofSha256"
     OR NEW."proofName" IS DISTINCT FROM OLD."proofName"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment_reports: lo que reportó el paciente no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- El resto (abono, motivo, quién y cuándo) lo exige completo y coherente
  -- con el estado el CHECK payment_reports_status_check.
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.perio_exams_final_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF OLD."status" = 'FINAL'
     AND coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'perio_exams: un examen periodontal finalizado no se modifica ni se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_op_deliveries_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(pg_catalog.current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'post_op_instruction_deliveries es inalterable: una entrega registrada no se edita ni se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."firstOpenedAt" IS NOT NULL OR NEW."firstOpenedAt" IS NULL
     OR (pg_catalog.to_jsonb(NEW) - 'firstOpenedAt')
        IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'firstOpenedAt') THEN
    RAISE EXCEPTION 'post_op_instruction_deliveries es inalterable: una entrega registrada no se edita ni se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prescription_copy_links_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prescription_copy_links: no se borra un enlace de la copia de la receta (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'prescription_copy_links: un enlace invalidado no cambia (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."prescriptionId" IS DISTINCT FROM OLD."prescriptionId"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'prescription_copy_links: solo se marca invalidado (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prescriptions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  void_columns CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidedById', 'voidReason'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida no se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'ISSUED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - void_columns) IS DISTINCT FROM (to_jsonb(OLD) - void_columns) THEN
    RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida solo se puede anular'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.signature_requests_counters_monotonic()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."failedAttempts" < OLD."failedAttempts"
     OR NEW."codeSendCount" < OLD."codeSendCount" THEN
    RAISE EXCEPTION 'signature_requests: los intentos fallidos y los códigos enviados solo suben, no pueden bajar (DX-425)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.signature_requests_evidence_clock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  -- Hora de inicio de la transacción, en UTC y a milisegundos: igual que las
  -- columnas TIMESTAMP(3) que escribe Prisma y que la hora que lee la API
  -- antes de decidir. La forma UTC de abajo es la que admite
  -- test/server-time-utc.int-spec.ts (DX-226); no escribas aquí comentarios
  -- con las funciones de hora: esa prueba mira el texto de la función.
  db_now timestamp(3) := (pg_catalog.now() AT TIME ZONE 'UTC');
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Un superusuario (local, CI, semillas y pruebas que siembran historia)
  -- conserva las horas que escribe, igual que la purga de
  -- dx_forbid_clinical_record_mutation; la app (dentalix_app) y el owner de
  -- producción (sin superusuario) reciben las de la BD.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := db_now;
    IF NEW."openedAt" IS NOT NULL THEN NEW."openedAt" := db_now; END IF;
    IF NEW."verifiedAt" IS NOT NULL THEN NEW."verifiedAt" := db_now; END IF;
    IF NEW."lockedAt" IS NOT NULL THEN NEW."lockedAt" := db_now; END IF;
    IF NEW."signedAt" IS NOT NULL THEN NEW."signedAt" := db_now; END IF;
    IF NEW."codeSentAt" IS NOT NULL THEN NEW."codeSentAt" := db_now; END IF;
    RETURN NEW;
  END IF;

  IF NEW."openedAt" IS NOT NULL AND OLD."openedAt" IS NULL THEN
    NEW."openedAt" := db_now;
  END IF;
  IF NEW."verifiedAt" IS NOT NULL AND OLD."verifiedAt" IS NULL THEN
    NEW."verifiedAt" := db_now;
  END IF;
  IF NEW."lockedAt" IS NOT NULL AND OLD."lockedAt" IS NULL THEN
    NEW."lockedAt" := db_now;
  END IF;
  IF NEW."signedAt" IS NOT NULL AND OLD."signedAt" IS NULL THEN
    NEW."signedAt" := db_now;
  END IF;
  -- El envío del código se repite (reenvíos): cada cambio es un envío nuevo.
  IF NEW."codeSentAt" IS NOT NULL
     AND NEW."codeSentAt" IS DISTINCT FROM OLD."codeSentAt" THEN
    NEW."codeSentAt" := db_now;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.signature_requests_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF OLD."signedAt" IS NOT NULL
     OR OLD."revokedAt" IS NOT NULL
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
     OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."professionalUserId" IS DISTINCT FROM OLD."professionalUserId"
     OR NEW."professionalName" IS DISTINCT FROM OLD."professionalName"
     OR NEW."signerType" IS DISTINCT FROM OLD."signerType"
     OR NEW."signerName" IS DISTINCT FROM OLD."signerName"
     OR NEW."signerDocument" IS DISTINCT FROM OLD."signerDocument"
     OR NEW."destination" IS DISTINCT FROM OLD."destination"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."budgetContent" IS DISTINCT FROM OLD."budgetContent"
     OR NEW."budgetContentHash" IS DISTINCT FROM OLD."budgetContentHash"
     -- Las horas de la evidencia, una vez puestas, no se reescriben.
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
     OR (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'signature_requests: una solicitud firmada o anulada no cambia, ni su documento, destino o token (DX-243, DX-415)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.signed_consent_pdf_links_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signed_consent_pdf_links: no se borra un enlace de la copia (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'signed_consent_pdf_links: un enlace usado o invalidado no cambia (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."consentId" IS DISTINCT FROM OLD."consentId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'signed_consent_pdf_links: solo se marca usado o invalidado (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.signed_consent_pdfs_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signed_consent_pdfs: no se borra el estado del PDF firmado (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'READY' THEN
    RAISE EXCEPTION 'signed_consent_pdfs: un PDF firmado archivado es inalterable (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."consentId" IS DISTINCT FROM OLD."consentId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'signed_consent_pdfs: no cambia de consentimiento (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."updatedAt" := pg_catalog.timezone('utc', pg_catalog.now());
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_acceptances_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'treatment_plan_acceptances es inmutable: una aceptación firmada no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'treatment_plan_acceptances es inmutable: una aceptación firmada no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_items_cancellation_fee_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."price" IS NOT DISTINCT FROM OLD."price"
     AND NEW."discount" IS NOT DISTINCT FROM OLD."discount"
     AND NEW."discountReason" IS NOT DISTINCT FROM OLD."discountReason"
     AND NEW."discountReasonNote" IS NOT DISTINCT FROM OLD."discountReasonNote"
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt"
     AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
     AND NEW."catalogItemId" IS NOT DISTINCT FROM OLD."catalogItemId"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId"
     AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."cancellation_fees" f
     WHERE f."tenantId" = OLD."tenantId"
       AND f."patientId" = OLD."patientId"
       AND f."planItemId" = OLD."id"
       AND f."status" = 'CHARGED'
       AND f."voidedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'el ítem es un cargo por inasistencia o cancelación tardía vigente: su precio, descuento y estado no cambian ni se retira; se anula con la anulación del cargo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_items_catalog_currency_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."catalogCurrency" IS DISTINCT FROM OLD."catalogCurrency"
     AND NOT (OLD."catalogCurrency" IS NULL
              AND coalesce(current_setting('app.dx502_backfill', true), '') = 'on')
     AND NOT (NEW."planId" = OLD."planId"
              AND public."treatment_plan_item_reprice_allowed"(OLD."planId", OLD."id", OLD."status"::text, OLD."deletedAt")) THEN
    RAISE EXCEPTION 'la moneda del catálogo del ítem queda fijada al darlo de alta: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_items_locked_when_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- DX-417: un ítem tampoco SALE de un plan firmado hacia otro plan.
  IF TG_OP = 'UPDATE' AND NEW."planId" IS DISTINCT FROM OLD."planId" THEN
    PERFORM 1 FROM public."treatment_plans" WHERE "id" = OLD."planId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = OLD."planId") THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no pasan a otro plan'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  PERFORM 1 FROM public."treatment_plans" WHERE "id" = plan_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = plan_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: no admite ítems nuevos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."toothNumber" IS DISTINCT FROM OLD."toothNumber"
     OR NEW."surfaces" IS DISTINCT FROM OLD."surfaces"
     OR NEW."catalogItemId" IS DISTINCT FROM OLD."catalogItemId"
     OR NEW."catalogPrice" IS DISTINCT FROM OLD."catalogPrice"
     OR NEW."basePrice" IS DISTINCT FROM OLD."basePrice"
     OR NEW."priceSource" IS DISTINCT FROM OLD."priceSource"
     OR NEW."agreementId" IS DISTINCT FROM OLD."agreementId"
     OR NEW."agreementName" IS DISTINCT FROM OLD."agreementName"
     OR NEW."pricingLocationId" IS DISTINCT FROM OLD."pricingLocationId"
     OR NEW."price" IS DISTINCT FROM OLD."price"
     OR NEW."discount" IS DISTINCT FROM OLD."discount"
     OR NEW."discountReason" IS DISTINCT FROM OLD."discountReason"
     OR NEW."discountReasonNote" IS DISTINCT FROM OLD."discountReasonNote"
     OR NEW."discountById" IS DISTINCT FROM OLD."discountById"
     OR NEW."discountAt" IS DISTINCT FROM OLD."discountAt"
     OR NEW."discountLocationId" IS DISTINCT FROM OLD."discountLocationId"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR (NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED') THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_items_locked_when_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
  plan_status text;
  attribution text[] := ARRAY['performedById', 'performedByMembershipId',
                              'performedLocationId', 'completedAt', 'updatedAt'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT p."status"::text INTO plan_status
    FROM public."treatment_plans" p WHERE p."id" = plan_id FOR SHARE;
  IF plan_status IN ('CANCELLED', 'REJECTED', 'COMPLETED') THEN
    IF TG_OP = 'UPDATE'
       AND plan_status = 'COMPLETED'
       AND OLD."status"::text = 'ACCEPTED'
       AND NEW."status"::text = 'DONE'
       AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
       AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
       AND NEW."toothNumber" IS NOT DISTINCT FROM OLD."toothNumber"
       AND NEW."surfaces" IS NOT DISTINCT FROM OLD."surfaces"
       AND NEW."catalogItemId" IS NOT DISTINCT FROM OLD."catalogItemId"
       AND NEW."catalogPrice" IS NOT DISTINCT FROM OLD."catalogPrice"
       AND NEW."basePrice" IS NOT DISTINCT FROM OLD."basePrice"
       AND NEW."priceSource" IS NOT DISTINCT FROM OLD."priceSource"
       AND NEW."agreementId" IS NOT DISTINCT FROM OLD."agreementId"
       AND NEW."agreementName" IS NOT DISTINCT FROM OLD."agreementName"
       AND NEW."pricingLocationId" IS NOT DISTINCT FROM OLD."pricingLocationId"
       AND NEW."price" IS NOT DISTINCT FROM OLD."price"
       AND NEW."discount" IS NOT DISTINCT FROM OLD."discount"
       AND NEW."discountReason" IS NOT DISTINCT FROM OLD."discountReason"
       AND NEW."discountReasonNote" IS NOT DISTINCT FROM OLD."discountReasonNote"
       AND NEW."discountById" IS NOT DISTINCT FROM OLD."discountById"
       AND NEW."discountAt" IS NOT DISTINCT FROM OLD."discountAt"
       AND NEW."discountLocationId" IS NOT DISTINCT FROM OLD."discountLocationId"
       AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
       AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
      RETURN NEW;
    END IF;
    -- SEC-050: retirar el ítem de un cargo por inasistencia ya anulado.
    IF TG_OP = 'UPDATE'
       AND OLD."deletedAt" IS NULL
       AND NEW."deletedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['deletedAt', 'updatedAt'])
           = (to_jsonb(OLD) - ARRAY['deletedAt', 'updatedAt'])
       AND EXISTS (
         SELECT 1
           FROM public."cancellation_fees" f
          WHERE f."tenantId" = OLD."tenantId"
            AND f."patientId" = OLD."patientId"
            AND f."planItemId" = OLD."id"
            AND f."status" = 'CHARGED'
            AND f."voidedAt" IS NOT NULL
       ) THEN
      RETURN NEW;
    END IF;
    -- DX-502: rellenar UNA vez la moneda del catálogo de un ítem que no la
    -- tenía, solo desde el relleno de la migración (`app.dx502_backfill`), sin
    -- tocar nada más de la fila.
    IF TG_OP = 'UPDATE'
       AND coalesce(current_setting('app.dx502_backfill', true), '') = 'on'
       AND OLD."catalogCurrency" IS NULL
       AND (to_jsonb(NEW) - ARRAY['catalogCurrency', 'updatedAt'])
           = (to_jsonb(OLD) - ARRAY['catalogCurrency', 'updatedAt']) THEN
      RETURN NEW;
    END IF;
    -- DX-050: corregir quién o cuándo de un ítem ya REALIZADO.
    IF TG_OP = 'UPDATE'
       AND OLD."status"::text = 'DONE'
       AND NEW."status"::text = 'DONE'
       AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_items_reference_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF num_nonnulls(OLD."referenceCurrency", OLD."referencePriceInPlan",
                  OLD."basePriceInPlan", OLD."referenceRateFrom",
                  OLD."referenceRateTo", OLD."referenceRateSource",
                  OLD."referenceRateDate") > 0
     AND (NEW."referenceCurrency", NEW."referencePriceInPlan",
          NEW."basePriceInPlan", NEW."referenceRateFrom",
          NEW."referenceRateTo", NEW."referenceRateSource",
          NEW."referenceRateDate")
         IS DISTINCT FROM
         (OLD."referenceCurrency", OLD."referencePriceInPlan",
          OLD."basePriceInPlan", OLD."referenceRateFrom",
          OLD."referenceRateTo", OLD."referenceRateSource",
          OLD."referenceRateDate")
     AND NOT (NEW."planId" = OLD."planId"
              AND public."treatment_plan_item_reprice_allowed"(OLD."planId", OLD."id", OLD."status"::text, OLD."deletedAt")) THEN
    RAISE EXCEPTION 'la referencia del ítem en la moneda del plan queda fijada al escribirla: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plan_repricings_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'treatment_plan_repricings es de solo alta: una recotización no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- La purga de la clínica (owner, sin clínica en contexto) sí borra.
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'treatment_plan_repricings es de solo alta: una recotización no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plans_cancellation_fee_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN NEW;
  END IF;
  IF (NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" = 'COMPLETED')
     AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId"
     AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."treatment_plan_items" i
      JOIN public."cancellation_fees" f
        ON f."tenantId" = i."tenantId"
       AND f."patientId" = i."patientId"
       AND f."planItemId" = i."id"
     WHERE i."planId" = OLD."id"
       AND i."deletedAt" IS NULL
       AND f."status" = 'CHARGED'
       AND f."voidedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'el plan lleva un cargo por inasistencia o cancelación tardía vigente: no se cancela, rechaza ni cambia de moneda; anula antes el cargo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plans_credit_currency_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."patient_credit_entries" e
     WHERE e."tenantId" = OLD."tenantId"
       AND e."treatmentPlanId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'el plan tiene saldo a favor traspasado o devuelto en su moneda: la moneda del plan ya no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plans_locked_when_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW."currency" IS DISTINCT FROM OLD."currency"
      OR (NEW."status" IN ('DRAFT', 'PRESENTED', 'REJECTED') AND NEW."status" IS DISTINCT FROM OLD."status")
      OR NEW."patientId" IS DISTINCT FROM OLD."patientId")
     AND EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = OLD."id") THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: su moneda no cambia ni vuelve a borrador, a presentado ni a rechazado'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.treatment_plans_split_from_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."splitFromPlanId" IS DISTINCT FROM OLD."splitFromPlanId" THEN
    RAISE EXCEPTION 'el enlace del presupuesto pendiente con su plan original no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
