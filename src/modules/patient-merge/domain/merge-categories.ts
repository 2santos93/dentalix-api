/**
 * DX-266: cómo se agrupan, para la vista previa, las tablas que la fusión
 * reasigna (`dx_patient_merge_tables()` en la BD). Cada categoría cuenta su
 * tabla principal (citas, evoluciones, planes…): lo que una persona reconoce.
 * El detalle tabla por tabla va a la auditoría de la fusión.
 *
 * test/patient-merge.int-spec.ts comprueba que cada tabla de la lista de la BD
 * tiene categoría aquí y que no sobra ninguna.
 */
export const MERGE_CATEGORIES = [
  'appointments',
  'clinicalEntries',
  'odontogram',
  'periodontogram',
  'anamnesis',
  'consents',
  'documents',
  'prescriptions',
  'treatmentPlans',
  'payments',
  'coverages',
  'responsibleParties',
  'recalls',
  'other',
] as const;

export type MergeCategory = (typeof MERGE_CATEGORIES)[number];

/** La tabla que cuenta cada categoría (null: «otros», no se cuenta). */
export const MERGE_CATEGORY_PRIMARY_TABLE: Record<
  MergeCategory,
  string | null
> = {
  appointments: 'appointments',
  clinicalEntries: 'clinical_entries',
  odontogram: 'tooth_records',
  periodontogram: 'perio_exams',
  anamnesis: 'medical_history_versions',
  consents: 'patient_consents',
  documents: 'patient_documents',
  prescriptions: 'prescriptions',
  treatmentPlans: 'treatment_plans',
  payments: 'payments',
  coverages: 'patient_coverages',
  responsibleParties: 'patient_responsible_parties',
  recalls: 'patient_recalls',
  other: null,
};

export const MERGE_TABLE_CATEGORY: Record<string, MergeCategory> = {
  appointments: 'appointments',
  appointment_plan_items: 'appointments',
  appointment_reserved_overrides: 'appointments',
  appointment_status_reversals: 'appointments',
  appointment_waitlist: 'appointments',
  waitlist_offers: 'appointments',
  cancellation_fees: 'appointments',
  closing_queue_dismissals: 'appointments',
  post_op_instruction_deliveries: 'appointments',
  // DX-566: controles postoperatorios (la llamada tras el procedimiento).
  post_op_checks: 'appointments',
  clinical_entries: 'clinicalEntries',
  clinical_entry_addenda: 'clinicalEntries',
  clinical_entry_diagnoses: 'clinicalEntries',
  anesthesia_administrations: 'clinicalEntries',
  sedation_records: 'clinicalEntries',
  // DX-190: el caso de ortodoncia y sus controles (cuelgan de evoluciones).
  ortho_cases: 'clinicalEntries',
  ortho_visits: 'clinicalEntries',
  clinical_record_copies: 'clinicalEntries',
  patient_retention_actions: 'clinicalEntries',
  tooth_records: 'odontogram',
  patient_dentition_events: 'odontogram',
  patient_implants: 'odontogram',
  perio_exams: 'periodontogram',
  medical_history_versions: 'anamnesis',
  medical_history_reviews: 'anamnesis',
  medical_history_submissions: 'anamnesis',
  patient_consents: 'consents',
  patient_consent_countersignatures: 'consents',
  signature_requests: 'consents',
  signed_consent_pdfs: 'consents',
  signed_consent_pdf_links: 'consents',
  data_processing_consents: 'consents',
  patient_documents: 'documents',
  patient_certificates: 'documents',
  patient_certificate_copy_links: 'documents',
  // DX-572: órdenes de estudios y referencias, y los enlaces de su copia.
  external_orders: 'documents',
  external_order_copy_links: 'documents',
  // DX-017: órdenes de laboratorio (la prescripción del producto a medida).
  dental_lab_orders: 'documents',
  prescriptions: 'prescriptions',
  prescription_copy_links: 'prescriptions',
  treatment_plans: 'treatmentPlans',
  treatment_plan_items: 'treatmentPlans',
  treatment_plan_acceptances: 'treatmentPlans',
  treatment_plan_repricings: 'treatmentPlans',
  // DX-561: avisos del seguimiento automático de presupuestos.
  quote_follow_up_messages: 'treatmentPlans',
  payments: 'payments',
  payment_plans: 'payments',
  payment_links: 'payments',
  payment_reports: 'payments',
  payment_promises: 'payments',
  collection_notes: 'payments',
  opening_balances: 'payments',
  patient_credit_entries: 'payments',
  patient_credit_refunds: 'payments',
  patient_credit_transfers: 'payments',
  patient_coverages: 'coverages',
  patient_agreements: 'coverages',
  patient_responsible_parties: 'responsibleParties',
  patient_recalls: 'recalls',
  recall_contacts: 'recalls',
  reminder_opt_out_links: 'other',
  reminder_opt_out_match_warnings: 'other',
  patient_majority_reviews: 'other',
};
