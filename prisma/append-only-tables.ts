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
  // DX-570: las líneas del vuelto de un abono.
  'payment_change_lines',
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
  // DX-285: series de alineadores (un refinamiento abre otra) y entregas de
  // bandejas: solo se añaden.
  'ortho_aligner_series',
  'ortho_aligner_deliveries',
  // DX-091: el registro de excepciones al cierre contable (quién, cuándo y
  // por qué; dx_financial_lock_override_guard).
  'financial_lock_overrides',
  // DX-018: la liquidación de honorarios cerrada y su detalle (se corrige con
  // ajustes en la siguiente; dx_commission_settlement_guard).
  'commission_settlements',
  'commission_settlement_lines',
  // DX-205: lotes de «Actualizar precios» del catálogo y el historial de
  // precios de cada ítem (la app solo inserta y lee).
  'catalog_price_batches',
  'catalog_price_history',
  // DX-566: los intentos de llamada del control postoperatorio (solo se
  // añaden; dx_post_op_check_attempts_immutable).
  'post_op_check_attempts',
  // DX-561: los avisos del seguimiento automático de presupuestos (enviados u
  // omitidos; la app solo inserta y lee; dx_quote_follow_up_messages_guard).
  'quote_follow_up_messages',
  // DX-137: a qué clínica pertenece una familia de refresh (solo se crea; se
  // va con su familia por la cascada).
  'clinic_sessions',
  // DX-562: la serie de citas solo se crea (su estado sale de sus citas; sus
  // citas la referencian con RESTRICT).
  'appointment_series',
  // DX-571: lo importado del extracto del banco (la importación y sus
  // movimientos de entrada; dx_bank_statement_guard).
  'bank_statement_imports',
  'bank_movements',
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
  // DX-285: los cargos del caso en el plan (se apunta el control que realiza
  // cada uno; nunca se borran).
  'ortho_case_charges',
  // DX-017: el laboratorio y sus servicios (se desactivan) y la orden de
  // laboratorio (se anula con motivo; dx_dental_lab_orders_guard).
  'dental_labs',
  'dental_lab_services',
  'dental_lab_orders',
  // DX-018: la regla de honorarios se desactiva, no se borra
  // (dx_commission_rule_guard).
  'commission_rules',
  // DX-568: el envío semanal cierra su estado y la entrega marca el uso del
  // enlace de baja; ninguno se borra (la unicidad por clínica y semana es la
  // que impide un segundo envío).
  'weekly_digest_runs',
  'weekly_digest_deliveries',
  // DX-464: el pago de una liquidación y sus líneas se anulan con motivo; el
  // enlace de conformidad se abre, firma o revoca una vez; nada se borra
  // (dx_commission_payment_guard, dx_commission_payment_line_guard y
  // dx_commission_receipt_request_guard).
  'commission_payments',
  'commission_payment_lines',
  'commission_receipt_requests',
  // DX-566: el control postoperatorio se cierra o se anula, nunca se borra
  // (dx_post_op_checks_guard).
  'post_op_checks',
  // DX-561: ajustes del seguimiento automático por sede. Apagar es
  // enabled = false; la fila no se borra (el upsert la bloquea al guardar).
  'location_quote_follow_up_settings',
  // DX-465: ajustes de intentos de recall por sede. Volver a 7/3 es
  // guardarlos; la fila no se borra (el upsert bloquea la sede al guardar).
  'location_recall_settings',
  // DX-137: el enlace «No fui yo» solo se marca usado (dx_session_alert_guard).
  'session_alerts',
  // DX-556: el prospecto se marca perdido y se anonimiza, nunca se borra
  // (dx_leads_guard); los motivos propios se retiran con borrado lógico.
  'leads',
  'lead_reasons',
  // DX-571: la cuenta de conciliación se desactiva, no se borra; el
  // emparejado solo se cierra (dx_bank_match_guard).
  'bank_accounts',
  'bank_reconciliation_matches',
  // DX-588: la pantalla de sala de espera se revoca, no se borra; el
  // contador de turnos del día solo sube.
  'waiting_room_screens',
  'location_turn_counters',
  // DX-265: los ajustes de «Ya llegué» de una sede no se borran (el QR se
  // retira dejando su hash a NULL); el contador de intentos del QR se reinicia
  // al vencer su ventana, nunca se borra.
  'location_check_in_settings',
  'location_check_in_attempts',
  // DX-053: el historial de exportaciones no se borra (el fichero sí, del
  // almacén, a los 7 días: `fileDeletedAt`).
  'clinic_exports',
] as const;

/**
 * Sin DELETE ni UPDATE de la tabla, con UPDATE solo de estas columnas
 * (DX-104, absorbida en DX-148): anular una receta escribe el estado y la
 * anulación; el trigger "prescriptions_immutable" sigue mirando el resto.
 */
export const APP_UPDATE_COLUMNS_ONLY: Record<string, readonly string[]> = {
  prescriptions: ['status', 'voidedAt', 'voidedById', 'voidReason'],
};
