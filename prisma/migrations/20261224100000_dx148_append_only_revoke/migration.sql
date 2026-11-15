-- DX-148: la app (dentalix_app) pierde UPDATE y DELETE en las tablas
-- append-only, y nota que corrige los comentarios de DX-120, DX-039 y DX-097.
--
-- 1. REVOKE en las tablas append-only
--
-- Hasta hoy las protegía SOLO su trigger de inmutabilidad: con el GRANT por
-- defecto (docker/db-init, docker/prod/create-app-role.sql) dentalix_app tenía
-- UPDATE y DELETE, y un trigger desactivado, reemplazado o con un fallo
-- dejaba la puerta abierta. Ahora la primera barrera es el privilegio; el
-- trigger sigue (también frena al owner, que no pierde nada).
--
-- Se revoca UPDATE, DELETE y TRUNCATE donde el trigger rechaza SIEMPRE el
-- UPDATE y el DELETE de un rol que no es superusuario, y ninguna ruta de la
-- app los usa (revisado: ni update/updateMany/upsert/delete/deleteMany de
-- Prisma, ni SQL crudo, ni SELECT … FOR UPDATE/SHARE, que también exige
-- UPDATE). Solo DELETE y TRUNCATE donde la app necesita UPDATE para anular,
-- cerrar o marcar (anulación con motivo, cierre de caja, enlace invalidado),
-- o lo bloquea con SELECT … FOR UPDATE (clinical_entries, en la hoja de
-- sedación). Detalle por tabla: README, «Migraciones en caliente», y
-- .planning/DX-148/INFORME.md.
--
-- Las ya revocadas por su propia migración (audit_events y sus particiones,
-- platform_access_audit, platform_audit_events, payment_allocation_movements,
-- patient_credit_*, cancellation_*, closing_queue_dismissals,
-- appointment_reserved_overrides, payment_adjustments,
-- treatment_plan_repricings, las sedation_* y signature_requests, entre
-- otras) no se tocan aquí; las que repite create-app-role.sql sí van en su
-- lista, para que repetir el bootstrap sobre una base migrada no las reabra.
--
-- Los borrados por la purga de la clínica o de la retención los hace el
-- owner (DIRECT_URL) y las acciones ON DELETE de las FK corren con el owner
-- de la tabla: ninguno depende del privilegio de dentalix_app.
--
-- No toca datos, la RLS, los triggers ni el esquema de Prisma (sin drift).
-- GRANT/REVOKE solo cambian el catálogo; lock_timeout por si una transacción
-- larga retiene alguna de estas tablas.
--
-- 2. Nota sobre DX-120, DX-039 y DX-097 (no se editan: cambiaría el checksum)
--
--   20261017180000_dx120_dentition_and_record_origin y
--   20261017180300_tooth_records_voids_record_fk dicen que NOT VALID +
--   VALIDATE evita recorrer la tabla con el bloqueo fuerte. No es así: el
--   NOT VALID y su VALIDATE van en el MISMO fichero, Prisma lo ejecuta en una
--   sola transacción y el ACCESS EXCLUSIVE del ADD CONSTRAINT sigue tomado
--   durante el VALIDATE (medido con pg_locks). El VALIDATE tiene que ir en una
--   migración posterior.
--
--   20261017170000_dx039_clinical_record_retention hace el backfill de
--   patients.last_attention_at con un UPDATE de toda la tabla en la misma
--   transacción que su ALTER TABLE: `patients` queda bloqueada, también para
--   lectura, mientras dura (4,6 s con 100k pacientes). El backfill tenía que
--   ir fuera de la migración de esquema, por lotes.
--
--   20261017113000_payments_civil_day_noon (DX-097) mueve los abonos con un
--   solo UPDATE junto al DDL de su tabla de rastro: `payments` queda con sus
--   filas bloqueadas hasta el COMMIT. Mismo patrón correcto: por lotes, fuera.
--
--   El patrón correcto y el lint que lo vigila en la CI
--   (`npm run db:lint-migrations`): README, «Migraciones en caliente».

SET LOCAL lock_timeout = '5s';

-- Append-only puras: ni UPDATE ni DELETE.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "anesthesia_administrations",
  "sedation_checklists",
  "sedation_agent_administrations",
  "sedation_vitals",
  "sedation_discharges",
  "cash_session_closing_lines",
  "cash_session_closings",
  "cash_session_floats",
  "cash_session_reopenings",
  "clinical_entry_addenda",
  "clinical_entry_diagnoses",
  "collection_notes",
  "data_processing_consents",
  "privacy_policy_versions",
  "medical_history_reviews",
  "medical_history_versions",
  "patient_consent_countersignatures",
  "patient_consents",
  "patient_dentition_events",
  "patient_retention_actions",
  "prescription_items",
  "recall_contacts",
  "reminder_opt_out_match_warnings",
  "tooth_records",
  "treatment_plan_acceptances"
FROM dentalix_app;

-- Recetas (DX-104, absorbida aquí): anular escribe el estado y la anulación;
-- la app solo puede actualizar esas columnas (también le basta para el
-- SELECT … FOR NO KEY UPDATE de la copia de la receta) y nunca borra.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "prescriptions" FROM dentalix_app;
GRANT UPDATE ("status", "voidedAt", "voidedById", "voidReason")
  ON TABLE "prescriptions" TO dentalix_app;

-- Se anulan, se cierran o se bloquean con FOR UPDATE: la app conserva UPDATE
-- (el trigger limita qué columnas cambian), pero nunca borra.
REVOKE DELETE, TRUNCATE ON TABLE
  "cash_session_adjustments",
  "cash_sessions",
  "clinical_entries",
  "expense_payments",
  "expenses",
  "medical_history_submissions",
  "patient_documents",
  "patient_implants",
  "payment_promises",
  "payment_receipt_counters",
  "payment_receipts"
FROM dentalix_app;
