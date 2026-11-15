/**
 * DX-148: tablas append-only en las que `dentalix_app` no tiene UPDATE ni
 * DELETE (o solo no tiene DELETE). Las revoca cada migración (la de DX-148,
 * 20261224100000_dx148_append_only_revoke, y las anteriores de cada tabla);
 * docker/prod/create-app-role.sql las vuelve a revocar si se repite el
 * bootstrap sobre una base migrada, y `npm run db:check-force` falla si la app
 * recupera alguno de esos privilegios. test/append-only-grants.int-spec.ts
 * comprueba que las tres listas coinciden.
 *
 * Criterio: el trigger de la tabla rechaza siempre el UPDATE y el DELETE de un
 * rol que no es superusuario, y ninguna ruta de la app los usa. Si la app
 * necesita UPDATE (anular con motivo, cerrar, marcar un enlace como usado o
 * bloquear la fila con SELECT … FOR UPDATE, que exige UPDATE), la tabla va en
 * NO_APP_DELETE: el trigger limita qué columnas cambian. Detalle por tabla en
 * el README, «Migraciones en caliente».
 */

/** Sin UPDATE ni DELETE (ni TRUNCATE). `audit_events` incluye sus particiones. */
export const NO_APP_UPDATE_DELETE = [
  // DX-148
  'anesthesia_administrations',
  'cash_session_closing_lines',
  'cash_session_closings',
  'cash_session_floats',
  'cash_session_reopenings',
  'clinical_entry_addenda',
  'clinical_entry_diagnoses',
  'collection_notes',
  'data_processing_consents',
  'medical_history_reviews',
  'medical_history_versions',
  'patient_consent_countersignatures',
  'patient_consents',
  'patient_dentition_events',
  'patient_retention_actions',
  'prescription_items',
  'privacy_policy_versions',
  'recall_contacts',
  'reminder_opt_out_match_warnings',
  'sedation_agent_administrations',
  'sedation_checklists',
  'sedation_discharges',
  'sedation_vitals',
  'tooth_records',
  'treatment_plan_acceptances',
  // Revocadas antes por su propia migración.
  'appointment_reserved_overrides',
  'audit_events',
  'cancellation_policy_versions',
  'clinical_record_copies',
  'closing_queue_dismissals',
  'patient_credit_entries',
  'patient_credit_refund_payments',
  'patient_credit_refunds',
  'patient_credit_transfers',
  'payment_adjustments',
  'payment_allocation_movements',
  'platform_access_audit',
  'platform_audit_events',
  'treatment_plan_repricings',
] as const;

/** Sin DELETE (ni TRUNCATE); conservan UPDATE para anular, cerrar o bloquear. */
export const NO_APP_DELETE = [
  // DX-148
  'cash_session_adjustments',
  'cash_sessions',
  'clinical_entries',
  'expense_payments',
  'expenses',
  'medical_history_submissions',
  'patient_documents',
  'patient_implants',
  'payment_promises',
  'payment_receipt_counters',
  'payment_receipts',
  // Revocadas antes por su propia migración.
  'equipment_maintenances',
  'patient_certificate_copy_links',
  'patient_certificates',
  'prescription_copy_links',
  'sedation_records',
  'signature_requests',
  'signed_consent_pdf_links',
  'signed_consent_pdfs',
] as const;

/**
 * Sin DELETE ni UPDATE de la tabla, con UPDATE solo de estas columnas
 * (DX-104, absorbida en DX-148): anular una receta escribe el estado y la
 * anulación; el trigger "prescriptions_immutable" sigue mirando el resto.
 */
export const APP_UPDATE_COLUMNS_ONLY: Record<string, readonly string[]> = {
  prescriptions: ['status', 'voidedAt', 'voidedById', 'voidReason'],
};
