import type { PrismaClient } from '@prisma/client';
import { DEMO_EMAIL_DOMAIN, DEMO_SUBDOMAIN } from '../../prisma/seed-demo';

// Toda tabla con `tenantId`, en orden seguro para borrar (hijas primero).
export const TENANT_TABLES = [
  // DX-291: cargos por inasistencia (hijos de appointments, ítems y políticas).
  'cancellation_fees',
  // DX-273: salidas de COMPLETED (hijas de appointments).
  'appointment_status_reversals',
  'appointment_plan_items',
  // DX-233: horario de los profesionales (hijas de locations, en orden de FK).
  'provider_schedule_override_ranges',
  'provider_schedule_overrides',
  'provider_schedule_ranges',
  'provider_schedules',
  // DX-222: entregas (hijas de appointments, patients, locations y plantillas)
  // y vínculos (hijos de plantillas y de appointment_types).
  'post_op_instruction_deliveries',
  'post_op_instruction_template_links',
  'post_op_instruction_templates',
  // DX-203: responsables (hijos de patients).
  'patient_responsible_parties',
  // DX-105: asignaciones de convenio (hijas de patients, convenios y coberturas).
  'patient_agreements',
  // DX-153: coberturas (hijas de patients y payers). Los pagadores van más abajo
  // (los convenios los referencian).
  'patient_coverages',
  'patient_implants',
  // DX-151: documentos (hijos de patients y locations).
  'patient_documents',
  // DX-027: caja por turno (hijas de cash_sessions y de payments).
  'cash_session_adjustments',
  'cash_session_reopenings',
  'cash_session_closing_lines',
  'cash_session_closings',
  'cash_session_floats',
  // DX-274: pagos de gastos (hijos de expenses y cash_sessions; los ajustes
  // OUTFLOW_VOID los referencian) y gastos y categorías (hijos de locations).
  'expense_payments',
  'expenses',
  'expense_categories',
  // DX-150: cobranza (hijas de patients y locations).
  'collection_notes',
  'payment_promises',
  'prescription_items',
  'prescriptions',
  'prescription_templates',
  'perio_site_measures',
  'perio_tooth_measures',
  'perio_exams',
  'patient_consents',
  'consent_templates',
  'installments',
  'payment_plans',
  // DX-051: imputación de abonos (hijas de payments, de los ítems y de los
  // planes). Las imputaciones antes que su historial: borrarlas deja su
  // movimiento.
  'payment_allocations',
  'payment_allocation_movements',
  'payment_plan_amounts',
  'plan_allocation_rebalance_requests',
  'payments',
  // Después de payments (payments."cashSessionId").
  'cash_sessions',
  'treatment_plan_acceptances',
  'treatment_plan_items',
  // DX-105: tras treatment_plan_items (agreementId, RESTRICT): precios de lista,
  // convenios (hijos de payers y listas), listas (hijas de locations) y, al fin,
  // los pagadores (DX-153).
  'price_list_items',
  'agreements',
  'price_lists',
  'payers',
  'treatment_plans',
  'tooth_records',
  'patient_dentition_events',
  'clinical_entry_addenda',
  // DX-212: diagnósticos CIE-10 (hijos de clinical_entries).
  'clinical_entry_diagnoses',
  'clinical_entries',
  'clinical_note_template_prompts',
  'clinical_note_templates',
  // DX-099: anamnesis por enlace (hijas de versions, appointments, patients y
  // locations).
  'medical_history_submissions',
  // DX-247: confirmaciones «Sin cambios hoy» (hijas de medical_history_versions).
  'medical_history_reviews',
  'medical_history_versions',
  'appointment_confirmations',
  // DX-210: ofertas de huecos (hijas de appointment_waitlist y appointments).
  'waitlist_offers',
  'appointment_waitlist',
  'appointments',
  // DX-279: versiones de la política de cancelación (las citas las citan).
  'cancellation_policy_versions',
  'appointment_types',
  'inventory_movements',
  'inventory_items',
  'schedule_blocks',
  'location_schedule_ranges',
  'location_schedules',
  'data_processing_consents',
  'privacy_policy_versions',
  'patients',
  'dental_catalog_items',
  'clinic_invitations',
  // DX-089: sedes de un miembro (hijas de clinic_memberships y locations).
  'membership_locations',
  'clinic_memberships',
  'tenant_domains',
  // DX-316: calendario y festivos de la sede (hijos de locations).
  'location_holidays',
  'location_working_calendars',
  'locations',
] as const;

/**
 * Borra (duro, solo en la base de test) todo tenant demo, vivo o retirado, y
 * sus usuarios `@DEMO_EMAIL_DOMAIN`. `raw` es el superusuario (DIRECT_URL).
 */
export async function purgeDemoTenants(raw: PrismaClient): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: DEMO_SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    for (const table of TENANT_TABLES) {
      await raw.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenantId" = ANY($1::uuid[])`,
        ids,
      );
    }
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({
    where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } },
  });
}
