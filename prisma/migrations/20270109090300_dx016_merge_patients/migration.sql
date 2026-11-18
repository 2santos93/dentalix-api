-- DX-016: la lista cerrada de la fusión de pacientes (DX-266) con las dos
-- tablas nuevas de la reserva online que referencian a patients:
-- online_booking_requests.patientId y online_booking_verifications.patientId.
-- Es la de 20270107140100 (DX-561) + esas dos, en orden alfabético.
--
-- Vuelta atrás: recrear la función con la definición de 20270107140100.

CREATE OR REPLACE FUNCTION public.dx_patient_merge_tables()
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
    'dental_lab_orders.patientId',
    'external_order_copy_links.patientId',
    'external_orders.patientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'online_booking_requests.patientId',
    'online_booking_verifications.patientId',
    'opening_balances.patientId',
    'ortho_cases.patientId',
    'ortho_visits.patientId',
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
    'post_op_checks.patientId',
    'post_op_instruction_deliveries.patientId',
    'prescription_copy_links.patientId',
    'prescriptions.patientId',
    'quote_follow_up_messages.patientId',
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
