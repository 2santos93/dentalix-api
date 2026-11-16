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
  // DX-266: «No es duplicado». La app solo inserta y lee; la fusión
  // (dx_merge_patients, el dueño) pasa las del absorbido al conservado.
  'patient_duplicate_dismissals',
  // DX-190: el control de ortodoncia (se corrige con una adenda de su
  // evolución; dx_ortho_visits_immutable).
  'ortho_visits',
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
  // DX-572: la orden se anula o liga su resultado y el enlace de la copia se
  // gasta o se invalida (UPDATE limitado por external_orders_guard y
  // external_order_copy_links_guard).
  'external_order_copy_links',
  // DX-572 (D7): la plantilla no se borra, se desactiva.
  'external_order_templates',
  'external_orders',
  // DX-569: el enlace se abre, usa o anula y el reporte se decide (UPDATE
  // limitado por payment_links_guard y payment_reports_guard).
  'payment_links',
  'payment_reports',
  'prescription_copy_links',
  'sedation_records',
  'signature_requests',
  'signed_consent_pdf_links',
  'signed_consent_pdfs',
  // DX-190: el caso de ortodoncia (cabecera y estado; dx_ortho_cases_guard no
  // deja tocar uno cerrado).
  'ortho_cases',
  // DX-017: el laboratorio y sus servicios (se desactivan) y la orden de
  // laboratorio (se anula con motivo; dx_dental_lab_orders_guard).
  'dental_labs',
  'dental_lab_services',
  'dental_lab_orders',
] as const;

/**
 * Sin DELETE ni UPDATE de la tabla, con UPDATE solo de estas columnas
 * (DX-104, absorbida en DX-148): anular una receta escribe el estado y la
 * anulación; el trigger "prescriptions_immutable" sigue mirando el resto.
 */
export const APP_UPDATE_COLUMNS_ONLY: Record<string, readonly string[]> = {
  prescriptions: ['status', 'voidedAt', 'voidedById', 'voidReason'],
};
