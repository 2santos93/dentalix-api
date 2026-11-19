import { PlanVisitsController } from '../treatment-plans/presentation/plan-visits.controller';
import { AppointmentsController } from '../appointments/presentation/appointments.controller';
import { RequestMethod, Type } from '@nestjs/common';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AuditInterceptor } from './presentation/audit.interceptor';
import { AUDIT_OPTIONS, type AuditOptions } from './presentation/audit-options';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AuthController } from '../auth/presentation/auth.controller';
import { PatientCertificatesController } from '../patient-certificates/presentation/patient-certificates.controller';
import {
  ExternalOrdersController,
  PatientExternalOrdersController,
} from '../external-orders/presentation/external-orders.controller';
import { ClinicalRecordCopiesController } from '../clinical-record-copies/presentation/clinical-record-copies.controller';
import { PatientsController } from '../patients/presentation/patients.controller';
import { CallerLookupController } from '../caller-lookup/presentation/caller-lookup.controller';
import { PatientAgreementsController } from '../patient-agreements/presentation/patient-agreements.controller';
import { PatientCoveragesController } from '../patient-coverages/presentation/patient-coverages.controller';
import { PatientResponsiblePartiesController } from '../patients/presentation/patient-responsible-parties.controller';
import { PatientMajorityReviewController } from '../patients/presentation/patient-majority-review.controller';
import { MedicalHistoryController } from '../medical-history/presentation/medical-history.controller';
import { PatientAnamnesisRequestsController } from '../medical-history-submissions/presentation/patient-anamnesis-requests.controller';
import { PatientSignatureRequestsController } from '../signature-requests/presentation/patient-signature-requests.controller';
import { MedicalHistorySubmissionsController } from '../medical-history-submissions/presentation/medical-history-submissions.controller';
import { ClinicalEntriesController } from '../clinical-entries/presentation/clinical-entries.controller';
import { ClinicalEntrySettingsController } from '../clinical-entries/presentation/clinical-entry-settings.controller';
import { DentalCatalogController } from '../dental-catalog/presentation/dental-catalog.controller';
import { CatalogPriceChangesController } from '../dental-catalog/presentation/catalog-price-changes.controller';
import { PriceListsController } from '../price-lists/presentation/price-lists.controller';
import { AgreementsController } from '../agreements/presentation/agreements.controller';
import { LocationsController } from '../locations/presentation/locations.controller';
import { LocationCalendarController } from '../location-calendar/presentation/location-calendar.controller';
import { OdontogramController } from '../odontogram/presentation/odontogram.controller';
import { PerioExamsController } from '../periodontal/presentation/perio-exams.controller';
import { PatientConsentsController } from '../consents/presentation/patient-consents.controller';
import { PatientDataConsentsController } from '../data-consents/presentation/patient-data-consents.controller';
import {
  PatientPrescriptionsController,
  PrescriptionsController,
} from '../prescriptions/presentation/prescriptions.controller';
import { TreatmentPlansController } from '../treatment-plans/presentation/treatment-plans.controller';
import { PlanQuoteController } from '../treatment-plans/presentation/plan-quote.controller';
import { PriceQuoteController } from '../treatment-plans/presentation/price-quote.controller';
import { QuoteSettingsController } from '../treatment-plans/presentation/quote-settings.controller';
import { SlotOfferSettingsController } from '../waitlist/presentation/slot-offer-settings.controller';
import { PlanRepricingController } from '../treatment-plans/presentation/plan-repricing.controller';
import { PlanFollowUpController } from '../treatment-plans/presentation/plan-follow-up.controller';
import { QuoteFollowUpPauseController } from '../quote-follow-up/presentation/quote-follow-up-pause.controller';
import { PaymentsController } from '../payments/presentation/payments.controller';
import { PaymentReceiptsController } from '../payments/presentation/payment-receipts.controller';
import { PaymentReceiptSummaryController } from '../payments/presentation/payment-receipt-summary.controller';
import { ReceiptSettingsController } from '../payments/presentation/receipt-settings.controller';
import { PaymentAllocationsController } from '../payments/presentation/payment-allocations.controller';
import { PaymentPlansController } from '../payment-plans/presentation/payment-plans.controller';
import { InstallmentSimulationController } from '../payment-plans/presentation/installment-simulation.controller';
import { AccountStatementController } from '../account-statement/presentation/account-statement.controller';
import { ReceivablesController } from '../receivables/presentation/receivables.controller';
import { DiscountPolicyController } from '../discounts/presentation/discount-policy.controller';
import { PatientCreditController } from '../patient-credit/presentation/patient-credit.controller';
import { CancellationPolicyController } from '../cancellation-policies/presentation/cancellation-policy.controller';
import { CancellationFeeController } from '../cancellation-fees/presentation/cancellation-fee.controller';
import { DiscountReportController } from '../discounts/presentation/discount-report.controller';
import { ProductionByProcedureController } from '../reports/presentation/production-by-procedure.controller';
import { QuoteFunnelController } from '../reports/presentation/quote-funnel.controller';
import { AcquisitionController } from '../reports/presentation/acquisition.controller';
import {
  PatientAcquisitionController,
  PatientSourcesController,
} from '../patient-sources/presentation/patient-sources.controller';
import { ScheduledProductionController } from '../reports/presentation/scheduled-production.controller';
import { UnallocatedPaymentsController } from '../reports/presentation/unallocated-payments.controller';
import { RecoveredSlotsController } from '../reports/presentation/recovered-slots.controller';
import { ChairOccupancyController } from '../reports/presentation/chair-occupancy.controller';
import { ClosingQueueController } from '../closing-queue/presentation/closing-queue.controller';
import { PostOpChecksController } from '../post-op-checks/presentation/post-op-checks.controller';
import { LeadsController } from '../leads/presentation/leads.controller';
import { LeadReasonsController } from '../leads/presentation/lead-reasons.controller';
import { ContingencyAgendaController } from '../contingency-agenda/presentation/contingency-agenda.controller';
import { CollectionsController } from '../collections/presentation/collections.controller';
import {
  PatientRecallsController,
  RecallController,
} from '../recall/presentation/recall.controller';
import { CashSessionsController } from '../cash-sessions/presentation/cash-sessions.controller';
import { ScheduleBlocksController } from '../schedule-blocks/presentation/schedule-blocks.controller';
import { ChairsController } from '../chairs/presentation/chairs.controller';
import { EquipmentController } from '../equipment/presentation/equipment.controller';
import { StaffController } from '../staff/presentation/staff.controller';
import { ClinicalNoteTemplatesController } from '../clinical-note-templates/presentation/clinical-note-templates.controller';
import { TreatmentPlanTemplatesController } from '../treatment-plan-templates/presentation/treatment-plan-templates.controller';
import { PlanTemplateApplyController } from '../treatment-plans/presentation/plan-template-apply.controller';
import { AnesthesiaController } from '../anesthesia/presentation/anesthesia.controller';
import { AnestheticsController } from '../anesthesia/presentation/anesthetics.controller';
import { SedationController } from '../sedation/presentation/sedation.controller';
import { DomainsController } from '../domains/presentation/domains.controller';
import { PostOpTemplatesController } from '../post-op-instructions/presentation/post-op-templates.controller';
import { AppointmentPostOpController } from '../post-op-instructions/presentation/appointment-post-op.controller';
import { PatientPostOpDeliveriesController } from '../post-op-instructions/presentation/patient-post-op-deliveries.controller';
import { PatientPaymentLinksController } from '../payment-links/presentation/patient-payment-links.controller';
import { PatientAccessLinksController } from '../patient-access/presentation/patient-access-links.controller';
import {
  ImplantsController,
  PatientImplantsController,
} from '../implants/presentation/implants.controller';
import {
  OrthoController,
  PatientOrthoController,
} from '../orthodontics/presentation/ortho.controller';
import {
  LabOrdersController,
  PatientLabOrdersController,
} from '../lab-orders/presentation/lab-orders.controller';
import { PatientDocumentsController } from '../patient-documents/presentation/patient-documents.controller';
import { ExpenseCategoriesController } from '../expenses/presentation/expense-categories.controller';
import { ExpenseReportsController } from '../expenses/presentation/expense-reports.controller';
import { ExpensesController } from '../expenses/presentation/expenses.controller';
import { CashOutflowsController } from '../expenses/presentation/cash-outflows.controller';
import { PatientImportsController } from '../patient-imports/presentation/patient-imports.controller';
import { BankReconciliationController } from '../bank-reconciliation/presentation/bank-reconciliation.controller';
import {
  ProviderScheduleController,
  ScheduleRosterController,
} from '../provider-schedule/presentation/provider-schedule.controller';
import { ExchangeSettingsController } from '../exchange/presentation/exchange-settings.controller';
import { PaymentMethodsController } from '../payment-methods/presentation/payment-methods.controller';
import { CommissionsController } from '../commissions/presentation/commissions.controller';
import { CommissionPaymentsController } from '../commissions/presentation/commission-payments.controller';
import { AppModule } from '../../app.module';
import {
  collectControllers,
  discoverRoutes,
} from '../../../test/support/route-discovery';

// Como en `auth-matrix.spec.ts`: el ConfigModule real valida el entorno al
// importarse y no declara controladores, así que un módulo vacío no quita
// ninguna ruta del recorrido de AppModule.
jest.mock('../../config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

/**
 * Qué endpoints quedan auditados y cómo (DX-009). Tabla escrita a mano: un
 * `@Audit` que desaparece, cambia de acción o de recurso, o una ruta nueva
 * auditada sin entrada, ponen `npm test` en rojo.
 *
 * Fuera a propósito: `GET /patients` (búsqueda, no es la ficha de nadie),
 * `GET /audit-events` (leer el propio registro) y `GET
 * /patients/:patientId/price-quote` (DX-105: calcula un precio, sin datos
 * clínicos ni escritura).
 */
const P = { param: 'patientId' } as const;
const RES = { response: 'id' } as const;
const plan = (param = 'id') => ({ lookup: 'treatmentPlan', param }) as const;

const EXPECTED: Record<string, AuditOptions> = {
  // DX-571: conciliación con el extracto del banco. La cuenta (alta, cambios,
  // las listas con nombres de pacientes y «Volver a emparejar»), la
  // importación (hash y contadores, nunca el contenido) y el emparejado a mano.
  'POST /bank-reconciliation/accounts': {
    action: 'CREATE',
    resource: 'BANK_ACCOUNT',
    resourceId: RES,
  },
  'PATCH /bank-reconciliation/accounts/:id': {
    action: 'UPDATE',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
  },
  'POST /bank-reconciliation/accounts/:id/statements': {
    action: 'CREATE',
    resource: 'BANK_STATEMENT_IMPORT',
    resourceId: RES,
    reason: 'IMPORT_CONFIRMED',
    importBatch: true,
  },
  'GET /bank-reconciliation/accounts/:id/summary': {
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'RECONCILIATION_SUMMARY',
  },
  'GET /bank-reconciliation/accounts/:id/items': {
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'RECONCILIATION_ITEMS',
  },
  'POST /bank-reconciliation/accounts/:id/auto-match': {
    action: 'UPDATE',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'AUTO_MATCH',
  },
  'GET /bank-reconciliation/movements/:id/candidates': {
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    reason: 'RECONCILIATION_CANDIDATES',
  },
  'POST /bank-reconciliation/matches': {
    action: 'CREATE',
    resource: 'BANK_RECONCILIATION_MATCH',
    resourceId: RES,
    reason: 'MANUAL_MATCH',
  },
  'DELETE /bank-reconciliation/matches/:id': {
    action: 'DELETE',
    resource: 'BANK_RECONCILIATION_MATCH',
    resourceId: { param: 'id' },
    reason: 'MANUAL_UNMATCH',
  },
  'GET /treatment-plans/unscheduled': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
  },
  'GET /treatment-plans/:id/visits': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
  },
  'PATCH /treatment-plans/:id/visits': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
    reason: 'PLAN_VISITS',
  },
  'POST /appointments': {
    action: 'CREATE',
    resource: 'APPOINTMENT',
    resourceId: RES,
    patient: { response: 'patientId' },
  },
  'PATCH /appointments/:id': {
    action: 'UPDATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
  },

  'POST /auth/login': { action: 'LOGIN', resource: 'SESSION' },

  'POST /patients': {
    action: 'CREATE',
    resource: 'PATIENT',
    resourceId: RES,
    patient: RES,
  },
  // DX-224: «¿Quién llama?», una lectura por paciente encontrado (`perMatch`);
  // el número buscado nunca va al evento. DX-556: los prospectos devueltos
  // (ADMIN y RECEPTION, sus sedes) dejan además, desde el caso de uso, un
  // VIEW LEAD (LEAD_CALLER_LOOKUP) cada uno: leads.int-spec.ts y
  // leads.e2e-spec.ts.
  'POST /patients/lookup-by-phone': {
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: RES,
    patient: RES,
    reason: 'CALLER_LOOKUP',
    perMatch: true,
  },
  'GET /patients/:id': {
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  },
  'PATCH /patients/:id': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  },
  // DX-484: cada descarga de la ficha para el software de imagen.
  'GET /patients/:id/imaging-export.txt': {
    action: 'EXPORT',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'IMAGING_EXPORT',
  },
  // DX-203: responsables de pago y avisos, con el motivo y los nombres de los
  // campos (nunca los datos del tercero).
  // SEC-044: la lectura (documento, email y teléfono de terceros) también.
  'GET /patients/:patientId/responsible-parties': {
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'RESPONSIBLE_PARTIES',
  },
  'POST /patients/:patientId/responsible-parties': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'RESPONSIBLE_PARTY_ADDED',
  },
  'PATCH /patients/:patientId/responsible-parties/:partyId': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'RESPONSIBLE_PARTY_CHANGED',
  },
  'DELETE /patients/:patientId/responsible-parties/:partyId': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'RESPONSIBLE_PARTY_REMOVED',
  },
  // DX-342: revisión del paso a la mayoría de edad; la decisión, la fecha y
  // el largo de la nota (nunca su texto) van en `metadata.majorityReview`.
  'POST /patients/:id/majority-review': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'MAJORITY_REVIEWED',
  },
  // DX-153: coberturas del paciente; motivo y nombres de campo, nunca el número
  // de afiliado ni el titular. SEC-049: alta, cambio y verificación llevan el
  // tipo de pagador, los 4 últimos del nº y si está verificada.
  'POST /patients/:patientId/coverages': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'COVERAGE_CREATED',
    coverage: true,
  },
  'PATCH /patients/:patientId/coverages/:coverageId': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'COVERAGE_CHANGED',
    coverage: true,
  },
  'POST /patients/:patientId/coverages/:coverageId/verification': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'COVERAGE_VERIFIED',
    coverage: true,
  },
  'DELETE /patients/:patientId/coverages/:coverageId': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'COVERAGE_REMOVED',
  },
  // DX-105: convenio del paciente; solo el motivo, sin el cuerpo.
  'PUT /patients/:patientId/agreement': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'AGREEMENT_ASSIGNED',
  },
  'DELETE /patients/:patientId/agreement': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: P,
    patient: P,
    reason: 'AGREEMENT_REMOVED',
  },
  // DX-039: archivar y retención de la HC.
  'DELETE /patients/:id': {
    action: 'DELETE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  },
  'PATCH /patients/:id/retention': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'RETENTION_EXTENSION_CHANGED',
  },
  'POST /patients/:id/partial-suppression': {
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'PARTIAL_SUPPRESSION',
  },

  'GET /patients/:patientId/medical-history': {
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: P,
  },
  'PUT /patients/:patientId/medical-history': {
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY',
    resourceId: RES,
    patient: P,
  },
  'POST /patients/:patientId/medical-history/no-changes': {
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY',
    resourceId: RES,
    patient: P,
    reason: 'NO_CHANGES_CONFIRMED',
  },
  // DX-099: anamnesis por enlace. Nunca la URL, el token, las respuestas ni
  // el motivo del rechazo: solo el id del envío y el código. El envío del
  // paciente se audita en su transacción (sin actor, origen LINK).
  'POST /patients/:patientId/medical-history/requests': {
    action: 'CREATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: RES,
    patient: P,
    reason: 'ANAMNESIS_LINK_CREATED',
  },
  'GET /medical-history/submissions/:id': {
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: { lookup: 'medicalHistorySubmission', param: 'id' },
  },
  'POST /medical-history/submissions/:id/accept': {
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: { lookup: 'medicalHistorySubmission', param: 'id' },
    reason: 'ANAMNESIS_ACCEPTED',
  },
  'POST /medical-history/submissions/:id/reject': {
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: { lookup: 'medicalHistorySubmission', param: 'id' },
    reason: 'ANAMNESIS_REJECTED',
  },
  'POST /medical-history/submissions/:id/revoke': {
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: { lookup: 'medicalHistorySubmission', param: 'id' },
    reason: 'ANAMNESIS_LINK_REVOKED',
  },

  'POST /patients/:patientId/clinical-entries': {
    action: 'CREATE',
    resource: 'CLINICAL_ENTRY',
    resourceId: RES,
    patient: P,
  },
  'POST /patients/:patientId/clinical-entries/:entryId/addenda': {
    action: 'CREATE',
    resource: 'CLINICAL_ENTRY_ADDENDUM',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/clinical-entries/:entryId/addenda': {
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY_ADDENDUM',
    resourceId: { param: 'entryId' },
    patient: P,
  },
  'GET /patients/:patientId/clinical-entries': {
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY',
    patient: P,
  },
  // DX-307: anestesia local en la evolución. Registrarla guarda los CÓDIGOS
  // de los avisos de dosis/alergia y si se confirmaron; la previsualización
  // lee la anamnesis vigente (peso y alergias).
  'GET /patients/:patientId/anesthesia': {
    action: 'VIEW',
    resource: 'ANESTHESIA_ADMINISTRATION',
    patient: P,
  },
  'GET /patients/:patientId/clinical-entries/:entryId/anesthesia': {
    action: 'VIEW',
    resource: 'ANESTHESIA_ADMINISTRATION',
    resourceId: { param: 'entryId' },
    patient: P,
  },
  'POST /patients/:patientId/clinical-entries/:entryId/anesthesia/check': {
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: P,
    reason: 'ANESTHESIA_DOSE_CHECK',
  },
  'POST /patients/:patientId/clinical-entries/:entryId/anesthesia': {
    action: 'CREATE',
    resource: 'ANESTHESIA_ADMINISTRATION',
    resourceId: RES,
    patient: P,
    anesthesiaSafety: true,
  },
  // DX-407: hoja de sedación. Cada parte es un CREATE de la hoja con un
  // código que la distingue; ni constantes, ni dosis, ni textos.
  'GET /patients/:patientId/sedation': {
    action: 'VIEW',
    resource: 'SEDATION_RECORD',
    patient: P,
  },
  'GET /patients/:patientId/clinical-entries/:entryId/sedation': {
    action: 'VIEW',
    resource: 'SEDATION_RECORD',
    resourceId: { param: 'entryId' },
    patient: P,
  },
  'POST /patients/:patientId/clinical-entries/:entryId/sedation': {
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: RES,
    patient: P,
    reason: 'SEDATION_ASSESSMENT',
  },
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/checklist': {
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: RES,
    patient: P,
    reason: 'SEDATION_CHECKLIST',
  },
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/agents': {
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: RES,
    patient: P,
    reason: 'SEDATION_AGENT',
  },
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/vitals': {
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: RES,
    patient: P,
    reason: 'SEDATION_VITALS',
  },
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/discharge': {
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: RES,
    patient: P,
    reason: 'SEDATION_DISCHARGE',
  },
  // DX-307: catálogo de anestésicos (sin paciente); desactivar es un PATCH.
  'POST /anesthetics': {
    action: 'CREATE',
    resource: 'ANESTHETIC_PRODUCT',
    resourceId: RES,
  },
  'POST /anesthetics/samples': {
    action: 'CREATE',
    resource: 'ANESTHETIC_PRODUCT',
    reason: 'SAMPLE_ANESTHETICS',
  },
  'PATCH /anesthetics/:id': {
    action: 'UPDATE',
    resource: 'ANESTHETIC_PRODUCT',
    resourceId: { param: 'id' },
  },
  // DX-212: los cambios del catálogo y de la sede.
  'POST /catalog/items': {
    action: 'CREATE',
    resource: 'DENTAL_CATALOG_ITEM',
    resourceId: RES,
  },
  'PATCH /catalog/items/:id': {
    action: 'UPDATE',
    resource: 'DENTAL_CATALOG_ITEM',
    resourceId: { param: 'id' },
  },
  // DX-205: un lote de «Actualizar precios» deja UN evento UPDATE con el lote
  // en `params.batchId` (el antes y el después de cada precio viven en
  // catalog_price_history, sin importes en el evento). Se reutiliza el
  // recurso DENTAL_CATALOG_ITEM de DX-212 en vez de crear CATALOG_ITEM.
  'POST /catalog/price-changes/apply': {
    action: 'UPDATE',
    resource: 'DENTAL_CATALOG_ITEM',
    reason: 'CATALOG_PRICES_BATCH',
  },
  // DX-105: listas de precios; el PUT de precios cuenta como UPDATE de la lista.
  'POST /price-lists': {
    action: 'CREATE',
    resource: 'PRICE_LIST',
    resourceId: RES,
  },
  'PATCH /price-lists/:id': {
    action: 'UPDATE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
  },
  'DELETE /price-lists/:id': {
    action: 'DELETE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
  },
  'PUT /price-lists/:id/items': {
    action: 'UPDATE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
    reason: 'PRICES_REPLACED',
  },
  // DX-105: convenios.
  'POST /agreements': {
    action: 'CREATE',
    resource: 'AGREEMENT',
    resourceId: RES,
  },
  'PATCH /agreements/:id': {
    action: 'UPDATE',
    resource: 'AGREEMENT',
    resourceId: { param: 'id' },
  },
  'DELETE /agreements/:id': {
    action: 'DELETE',
    resource: 'AGREEMENT',
    resourceId: { param: 'id' },
  },
  'PATCH /locations/:id': {
    action: 'UPDATE',
    resource: 'LOCATION',
    resourceId: { param: 'id' },
  },

  'POST /patients/:patientId/tooth-records': {
    action: 'CREATE',
    resource: 'ODONTOGRAM',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/odontogram': {
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: P,
  },
  'GET /patients/:patientId/teeth/:fdi/history': {
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: P,
  },
  // DX-120: dentición, sus cambios y la anulación de un registro.
  'POST /patients/:patientId/tooth-records/:recordId/void': {
    action: 'VOID',
    resource: 'ODONTOGRAM',
    resourceId: { param: 'recordId' },
    patient: P,
  },
  'GET /patients/:patientId/dentition': {
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: P,
  },
  'POST /patients/:patientId/dentition-events': {
    action: 'UPDATE',
    resource: 'ODONTOGRAM',
    patient: P,
    reason: 'DENTITION_CHANGED',
  },

  'GET /patients/:patientId/perio-exams': {
    action: 'VIEW',
    resource: 'PERIO_EXAM',
    patient: P,
  },
  'POST /patients/:patientId/perio-exams': {
    action: 'CREATE',
    resource: 'PERIO_EXAM',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/perio-exams/:id': {
    action: 'VIEW',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: P,
  },
  'PUT /patients/:patientId/perio-exams/:id/measures': {
    action: 'UPDATE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: P,
  },
  'POST /patients/:patientId/perio-exams/:id/finalize': {
    action: 'UPDATE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: P,
  },
  'DELETE /patients/:patientId/perio-exams/:id': {
    action: 'DELETE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: P,
  },

  'GET /patients/:patientId/consents': {
    action: 'VIEW',
    resource: 'CONSENT',
    patient: P,
  },
  'GET /patients/:patientId/consents/preview': {
    action: 'VIEW',
    resource: 'CONSENT',
    patient: P,
  },
  'POST /patients/:patientId/consents': {
    action: 'SIGN',
    resource: 'CONSENT',
    resourceId: RES,
    patient: P,
  },
  // DX-243: el profesional firma en la app uno firmado a distancia.
  'POST /patients/:patientId/consents/:id/countersign': {
    action: 'SIGN',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'CONSENT_COUNTERSIGNED',
  },
  // DX-422: reintentar el PDF firmado que la cola no pudo generar.
  'POST /patients/:patientId/consents/:id/signed-pdf/retry': {
    action: 'UPDATE',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'SIGNED_PDF_RETRY',
  },
  // DX-443: «Reenviar copia» del PDF firmado al paciente.
  'POST /patients/:patientId/consents/:id/signed-pdf/copy': {
    action: 'SEND',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'SIGNED_PDF_COPY_RESENT',
  },
  // DX-243: enviar a firmar a distancia y anular el enlace.
  'POST /patients/:patientId/signature-requests': {
    action: 'SEND',
    resource: 'SIGNATURE_REQUEST',
    resourceId: RES,
    patient: P,
    reason: 'SIGNATURE_REQUEST_SENT',
  },
  'POST /patients/:patientId/signature-requests/:id/revoke': {
    action: 'UPDATE',
    resource: 'SIGNATURE_REQUEST',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'SIGNATURE_REQUEST_REVOKED',
  },
  'GET /patients/:patientId/consents/:id': {
    action: 'VIEW',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: P,
  },

  'GET /patients/:patientId/data-consents': {
    action: 'VIEW',
    resource: 'DATA_CONSENT',
    patient: P,
  },
  'POST /patients/:patientId/data-consents': {
    action: 'CREATE',
    resource: 'DATA_CONSENT',
    patient: P,
  },

  'GET /patients/:patientId/prescriptions': {
    action: 'VIEW',
    resource: 'PRESCRIPTION',
    patient: P,
  },
  'POST /patients/:patientId/prescriptions': {
    action: 'CREATE',
    resource: 'PRESCRIPTION',
    resourceId: RES,
    patient: P,
    // DX-300: códigos de los avisos de seguridad y si se confirmaron.
    prescriptionSafety: true,
  },
  // DX-300: la previsualización de avisos lee la anamnesis vigente.
  'POST /patients/:patientId/prescriptions/safety-check': {
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: P,
    reason: 'PRESCRIPTION_SAFETY_CHECK',
  },
  'GET /prescriptions/:id': {
    action: 'VIEW',
    resource: 'PRESCRIPTION',
    resourceId: { param: 'id' },
    patient: { lookup: 'prescription', param: 'id' },
  },
  'POST /prescriptions/:id/void': {
    action: 'VOID',
    resource: 'PRESCRIPTION',
    resourceId: { param: 'id' },
    patient: { lookup: 'prescription', param: 'id' },
  },
  // DX-468: «Enviar al paciente» la copia de la receta (la apertura pública
  // la audita el caso de uso: VIEW sin usuario, PRESCRIPTION_COPY_OPENED).
  'POST /prescriptions/:id/patient-copy': {
    action: 'SEND',
    resource: 'PRESCRIPTION',
    resourceId: { param: 'id' },
    patient: { lookup: 'prescription', param: 'id' },
    reason: 'PRESCRIPTION_COPY_SENT',
  },

  // DX-306: certificados del paciente (justificante y reposo). Ni el
  // diagnóstico ni el motivo de la anulación van al evento.
  'GET /patients/:patientId/certificates': {
    action: 'VIEW',
    resource: 'PATIENT_CERTIFICATE',
    patient: P,
  },
  'POST /patients/:patientId/certificates': {
    action: 'CREATE',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: RES,
    patient: P,
    reason: 'CERTIFICATE_ISSUED',
  },
  'GET /patients/:patientId/certificates/:id/pdf': {
    action: 'PRINT',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: P,
  },
  'POST /patients/:patientId/certificates/:id/void': {
    action: 'VOID',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'CERTIFICATE_VOIDED',
  },
  // «Enviar por WhatsApp» la copia (la apertura y la descarga públicas las
  // audita el caso de uso: VIEW/EXPORT sin usuario, CERTIFICATE_COPY_*).
  'POST /patients/:patientId/certificates/:id/patient-copy': {
    action: 'SEND',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'CERTIFICATE_COPY_SENT',
  },

  // DX-572: órdenes de estudios y referencias externas. Ni la nota, ni los
  // estudios, ni el destinatario, ni el motivo de la anulación van al evento.
  'GET /patients/:patientId/external-orders': {
    action: 'VIEW',
    resource: 'EXTERNAL_ORDER',
    patient: P,
  },
  'POST /patients/:patientId/external-orders': {
    action: 'CREATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: RES,
    patient: P,
    reason: 'EXTERNAL_ORDER_ISSUED',
  },
  'GET /external-orders/pending': {
    action: 'VIEW',
    resource: 'EXTERNAL_ORDER',
  },
  'GET /external-orders/:id': {
    action: 'VIEW',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
  },
  'GET /external-orders/:id/pdf': {
    action: 'PRINT',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
  },
  'POST /external-orders/:id/void': {
    action: 'VOID',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
    reason: 'EXTERNAL_ORDER_VOIDED',
  },
  'POST /external-orders/:id/result': {
    action: 'UPDATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
    reason: 'EXTERNAL_ORDER_RESULT_LINKED',
  },
  'POST /external-orders/:id/result/unlink': {
    action: 'UPDATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
    reason: 'EXTERNAL_ORDER_RESULT_UNLINKED',
  },
  // La apertura y la descarga públicas las audita el caso de uso: VIEW/EXPORT
  // sin usuario, EXTERNAL_ORDER_COPY_OPENED/_DOWNLOADED.
  'POST /external-orders/:id/patient-copy': {
    action: 'SEND',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: { lookup: 'externalOrder', param: 'id' },
    reason: 'EXTERNAL_ORDER_COPY_SENT',
  },

  // DX-456: copia de la historia clínica. La generación (POST) la audita el
  // caso de uso en su transacción (AUDITED_IN_USE_CASE).
  'GET /patients/:patientId/clinical-record-copies': {
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: P,
    reason: 'CLINICAL_RECORD_COPIES_LISTED',
  },
  'GET /patients/:patientId/clinical-record-copies/:copyId/document': {
    action: 'PRINT',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: P,
    reason: 'CLINICAL_RECORD_COPY_PRINTED',
  },

  // DX-190: caso de ortodoncia, controles y lista de seguimiento (sin
  // paciente: muchos con teléfonos, como la de recall).
  'GET /patients/:patientId/ortho-cases': {
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    patient: P,
  },
  'POST /patients/:patientId/ortho-cases': {
    action: 'CREATE',
    resource: 'ORTHO_CASE',
    resourceId: RES,
    patient: P,
  },
  'PATCH /patients/:patientId/ortho-cases/:caseId': {
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: P,
    reason: 'ORTHO_CASE_UPDATED',
  },
  'GET /patients/:patientId/ortho-cases/:caseId/visits': {
    action: 'VIEW',
    resource: 'ORTHO_VISIT',
    patient: P,
  },
  'POST /patients/:patientId/ortho-cases/:caseId/visits': {
    action: 'CREATE',
    resource: 'ORTHO_VISIT',
    resourceId: RES,
    patient: P,
  },
  'GET /ortho/follow-up': {
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    reason: 'ORTHO_FOLLOW_UP',
  },
  // DX-285: cuenta del caso (los cuatro roles) y alineadores (sin importes
  // ni datos clínicos en la metadata).
  'GET /patients/:patientId/ortho-cases/accounts': {
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    patient: P,
    reason: 'ORTHO_CASE_ACCOUNTS',
  },
  'GET /patients/:patientId/ortho-cases/:caseId/account': {
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: P,
    reason: 'ORTHO_CASE_ACCOUNT',
  },
  'GET /patients/:patientId/ortho-cases/:caseId/aligners': {
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: P,
    reason: 'ORTHO_ALIGNERS',
  },
  'POST /patients/:patientId/ortho-cases/:caseId/aligner-series': {
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: P,
    reason: 'ORTHO_ALIGNER_SERIES',
  },
  'POST /patients/:patientId/ortho-cases/:caseId/aligner-series/:seriesId/deliveries':
    {
      action: 'UPDATE',
      resource: 'ORTHO_CASE',
      resourceId: { param: 'caseId' },
      patient: P,
      reason: 'ORTHO_ALIGNER_DELIVERY',
    },

  // DX-017: órdenes de laboratorio. La lista de la sede no lleva paciente
  // (muchos, como la de recall); los pasos, la edición y la impresión los
  // audita el caso de uso (AUDITED_IN_USE_CASE).
  'GET /patients/:patientId/lab-orders': {
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    patient: P,
  },
  'POST /patients/:patientId/lab-orders': {
    action: 'CREATE',
    resource: 'DENTAL_LAB_ORDER',
    resourceId: RES,
    patient: P,
  },
  'GET /lab-orders': {
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    reason: 'DENTAL_LAB_ORDER_LIST',
  },
  'GET /lab-orders/:id': {
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
  },

  // DX-191: registro de implantes, tarjeta y búsqueda por lote.
  'GET /patients/:patientId/implants': {
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    patient: P,
  },
  'POST /patients/:patientId/implants': {
    action: 'CREATE',
    resource: 'PATIENT_IMPLANT',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/implant-card': {
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    patient: P,
    reason: 'IMPLANT_CARD',
  },
  'POST /patients/:patientId/implant-card/print': {
    action: 'PRINT',
    resource: 'PATIENT_IMPLANT',
    patient: P,
    reason: 'IMPLANT_CARD',
  },
  'GET /implants/search': {
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    reason: 'IMPLANT_LOT_SEARCH',
    search: true,
  },
  'GET /implants/search.csv': {
    action: 'EXPORT',
    resource: 'PATIENT_IMPLANT',
    reason: 'IMPLANT_LOT_SEARCH',
    search: true,
  },
  'POST /implants/:id/void': {
    action: 'VOID',
    resource: 'PATIENT_IMPLANT',
    resourceId: { param: 'id' },
    patient: { lookup: 'patientImplant', param: 'id' },
  },

  // DX-107: lotes de importación de pacientes. `GET /patient-imports/:id`
  // fuera a propósito: la pantalla lo consulta cada pocos segundos mientras
  // importa (su informe, errors.csv, sí se audita).
  'POST /patient-imports': {
    action: 'CREATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: RES,
    reason: 'IMPORT_VALIDATED',
    importBatch: true,
  },
  'GET /patient-imports/:id/errors.csv': {
    action: 'EXPORT',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_ERRORS',
  },
  'POST /patient-imports/:id/confirm': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_CONFIRMED',
    importBatch: true,
  },
  'POST /patient-imports/:id/undo': {
    action: 'DELETE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_UNDONE',
    importBatch: true,
  },
  // DX-390: cobro dividido (un evento por línea, con su recibo único).
  'POST /treatment-plans/:id/split-payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'SPLIT_RECEIPT_ISSUED',
    paymentReference: true,
    splitPayment: true,
  },
  // DX-262: abono contra el saldo migrado (con su recibo de caja).
  'POST /opening-balances/:id/payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: { lookup: 'openingBalance', param: 'id' },
    reason: 'RECEIPT_ISSUED',
    paymentReference: true,
  },
  // DX-262: hoja de saldos del lote (dry-run, quitarla y su informe).
  'POST /patient-imports/:id/balances': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_VALIDATED',
    importBatch: true,
  },
  'POST /patient-imports/:id/balances/undo': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_UNDONE',
    importBatch: true,
  },
  'DELETE /patient-imports/:id/balances': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_REMOVED',
    importBatch: true,
  },
  'GET /patient-imports/:id/balances/errors.csv': {
    action: 'EXPORT',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCE_ERRORS',
  },
  // DX-263: hoja de citas del lote (dry-run, quitarla, su informe, retirar
  // sus citas y activar sus recordatorios).
  'POST /patient-imports/:id/appointments': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_APPOINTMENTS_VALIDATED',
    importBatch: true,
  },
  'DELETE /patient-imports/:id/appointments': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_APPOINTMENTS_REMOVED',
    importBatch: true,
  },
  'GET /patient-imports/:id/appointments/errors.csv': {
    action: 'EXPORT',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_APPOINTMENT_ERRORS',
  },
  'POST /patient-imports/:id/appointments/undo': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_APPOINTMENTS_UNDONE',
    importBatch: true,
  },
  'POST /patient-imports/:id/appointments/reminders': {
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_APPOINTMENT_REMINDERS_ENABLED',
    importBatch: true,
  },

  // DX-151: documentos del paciente. Ver la URL en línea es VIEW y descargar
  // es EXPORT; la metadata solo lleva el código, nunca el nombre del fichero.
  'POST /patients/:patientId/documents': {
    action: 'CREATE',
    resource: 'PATIENT_DOCUMENT',
    resourceId: RES,
    patient: P,
  },
  // DX-259: la subida directa se audita al completarla (crea la fila); pedir
  // la autorización (`upload-url`) no toca la ficha y no deja evento.
  'POST /patients/:patientId/documents/:id/complete': {
    action: 'CREATE',
    resource: 'PATIENT_DOCUMENT',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/documents': {
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    patient: P,
    reason: 'DOCUMENT_LIST',
  },
  'GET /patients/:patientId/documents/:id': {
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
  },
  'GET /patients/:patientId/documents/:id/url/inline': {
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'DOCUMENT_VIEW',
  },
  'GET /patients/:patientId/documents/:id/url/download': {
    action: 'EXPORT',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'DOCUMENT_DOWNLOAD',
  },
  'POST /patients/:patientId/documents/:id/void': {
    action: 'VOID',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
  },

  'POST /patients/:patientId/treatment-plans': {
    action: 'CREATE',
    resource: 'TREATMENT_PLAN',
    resourceId: RES,
    patient: P,
  },
  'GET /patients/:patientId/treatment-plans': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    patient: P,
  },
  'GET /treatment-plans/:id': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
  },
  'PATCH /treatment-plans/:id': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
  },
  'POST /treatment-plans/:id/items': {
    action: 'CREATE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: RES,
    patient: plan(),
  },
  'PATCH /treatment-plans/:id/items/:itemId': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: { param: 'itemId' },
    patient: { lookup: 'treatmentPlanItem', param: 'itemId' },
  },
  'DELETE /treatment-plans/:id/items/:itemId': {
    action: 'DELETE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: { param: 'itemId' },
    patient: { lookup: 'treatmentPlanItem', param: 'itemId' },
  },
  // DX-204: «Descuento %» sobre varios ítems: un evento con los nombres de los
  // campos, sin importes ni la nota del motivo.
  'POST /treatment-plans/:id/items/bulk-discount': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN_ITEM',
    patient: plan(),
    reason: 'BULK_DISCOUNT',
  },
  'GET /patients/:patientId/treatment-plans/:planId/quote': {
    action: 'PRINT',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
  },
  // DX-379: imprimir (la primera impresión fija la validez del presupuesto).
  'POST /patients/:patientId/treatment-plans/:planId/quote/issue': {
    action: 'PRINT',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
  },
  // DX-379 (B): «Actualizar precios». La vista previa lee el plan (VIEW);
  // aplicar deja UPDATE con PLAN_REPRICED y `params.repricingId` (la fila con
  // el antes y el después, el autor y la tasa; sin importes en el evento).
  'POST /patients/:patientId/treatment-plans/:planId/reprice/preview': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
    reason: 'REPRICE_PREVIEW',
  },
  'POST /patients/:patientId/treatment-plans/:planId/reprice/apply': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
    reason: 'PLAN_REPRICED',
  },
  // DX-379 (C): firmar un presupuesto vencido pone además, desde el handler,
  // `reason` QUOTE_EXPIRED_ORIGINAL_PRICES | QUOTE_EXPIRED_REPRICED y, al
  // recotizar, `params.repricingId` (sin importes; ver audit-request.spec).
  'POST /patients/:patientId/treatment-plans/:planId/acceptance': {
    action: 'SIGN',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
  },
  // La vista previa del presupuesto recotizado para firmarlo vencido: lee
  // el plan (VIEW) y no escribe nada (deshace su transacción).
  'POST /patients/:patientId/treatment-plans/:planId/acceptance/reprice-preview':
    {
      action: 'VIEW',
      resource: 'TREATMENT_PLAN',
      resourceId: { param: 'planId' },
      patient: P,
      reason: 'ACCEPT_REPRICE_PREVIEW',
    },
  // DX-417: la vista previa de aceptar en parte lee el plan (VIEW). La firma
  // parcial pone desde el handler `reason` PLAN_PARTIALLY_ACCEPTED (o el del
  // vencido) y `params.pendingPlanId`; además el caso de uso escribe el alta
  // del plan pendiente: CREATE TREATMENT_PLAN, `reason` PLAN_SPLIT_PENDING y
  // `params.splitFromPlanId` (sin importes; partial-acceptance.use-cases.spec).
  'POST /patients/:patientId/treatment-plans/:planId/acceptance/partial-preview':
    {
      action: 'VIEW',
      resource: 'TREATMENT_PLAN',
      resourceId: { param: 'planId' },
      patient: P,
      reason: 'ACCEPT_PARTIAL_PREVIEW',
    },
  // DX-040: presentar y rechazar cambian el plan; una alternativa es un plan
  // nuevo del mismo paciente. La lista de presupuestos por seguir es de
  // muchos pacientes (sin paciente en el evento), pero se audita porque
  // enseña montos y teléfonos.
  'POST /treatment-plans/:id/present': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
  },
  'POST /treatment-plans/:id/reject': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
  },
  'POST /treatment-plans/:id/alternatives': {
    action: 'CREATE',
    resource: 'TREATMENT_PLAN',
    resourceId: RES,
    patient: plan(),
  },
  'GET /treatment-plans/pending-follow-up': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
  },
  // DX-561: pausar o reanudar el seguimiento automático del presupuesto.
  'POST /treatment-plans/:id/follow-up/pause': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
    reason: 'QUOTE_FOLLOW_UP_PAUSED',
  },
  'POST /treatment-plans/:id/follow-up/resume': {
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
    reason: 'QUOTE_FOLLOW_UP_RESUMED',
  },

  'GET /payments': { action: 'VIEW', resource: 'PAYMENT' },
  // DX-395: descargar la caja en CSV (con medio y referencia).
  'GET /payments.csv': { action: 'EXPORT', resource: 'PAYMENT' },
  // DX-136: el recibo numerado se emite en la misma transacción que el abono.
  'POST /treatment-plans/:id/payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: plan(),
    reason: 'RECEIPT_ISSUED',
    // DX-377: confirmación de referencia repetida (ids, nunca el motivo).
    paymentReference: true,
    // DX-570: lo recibido y las líneas del vuelto (nunca la referencia).
    cashChange: true,
  },
  'GET /treatment-plans/:id/payments': {
    action: 'VIEW',
    resource: 'PAYMENT',
    patient: plan(),
  },
  'GET /treatment-plans/:id/balance': {
    action: 'VIEW',
    resource: 'PAYMENT',
    patient: plan(),
  },
  'DELETE /payments/:id': {
    action: 'VOID',
    resource: 'PAYMENT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  },
  // DX-051: ver y reasignar la imputación de un abono a los ítems del plan.
  'GET /payments/:id/allocations': {
    action: 'VIEW',
    resource: 'PAYMENT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  },
  // DX-136: ver, reimprimir y enviar el recibo de caja.
  'GET /payments/:id/receipt': {
    action: 'VIEW',
    resource: 'PAYMENT_RECEIPT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  },
  'POST /payments/:id/receipt/print': {
    action: 'PRINT',
    resource: 'PAYMENT_RECEIPT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  },
  'POST /payments/:id/receipt/email': {
    action: 'SEND',
    resource: 'PAYMENT_RECEIPT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  },
  // DX-401: ver, imprimir y enviar el resumen de recibos de un período (el
  // período va a `metadata.period`, desde el handler).
  'GET /patients/:patientId/payment-receipts/summary': {
    action: 'VIEW',
    resource: 'PAYMENT_RECEIPT_SUMMARY',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
  },
  'POST /patients/:patientId/payment-receipts/summary/print': {
    action: 'PRINT',
    resource: 'PAYMENT_RECEIPT_SUMMARY',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
  },
  'POST /patients/:patientId/payment-receipts/summary/email': {
    action: 'SEND',
    resource: 'PAYMENT_RECEIPT_SUMMARY',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
  },

  'POST /treatment-plans/:id/payment-plan': {
    action: 'CREATE',
    resource: 'PAYMENT_PLAN',
    resourceId: RES,
    patient: plan(),
  },
  'GET /treatment-plans/:id/payment-plan': {
    action: 'VIEW',
    resource: 'PAYMENT_PLAN',
    patient: plan(),
  },
  // DX-123: el historial de planes de cuotas cancelados.
  'GET /treatment-plans/:id/payment-plan/history': {
    action: 'VIEW',
    resource: 'PAYMENT_PLAN',
    patient: plan(),
  },
  'DELETE /treatment-plans/:id/payment-plan': {
    action: 'DELETE',
    resource: 'PAYMENT_PLAN',
    patient: plan(),
  },
  // DX-041: simular cuotas del presupuesto lee el plan (VIEW) y no escribe.
  // Aceptar con cuotas pone `params.paymentPlanId` en el SIGN y el caso de uso
  // escribe el alta del plan de cuotas (CREATE PAYMENT_PLAN, `reason`
  // PLAN_ACCEPTED_WITH_INSTALLMENTS).
  'POST /treatment-plans/:id/installment-simulation': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: plan(),
    reason: 'INSTALLMENT_SIMULATION',
  },

  'GET /patients/:patientId/account-statement': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    patient: P,
  },
  'GET /patients/:patientId/family-account-statement': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    patient: P,
    reason: 'FAMILY_ACCOUNT_STATEMENT',
    // SEC-044: un VIEW por miembro de la familia (pagador y dependientes).
    familyStatement: true,
  },
  'GET /patients/:patientId/billable-plans': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    patient: P,
  },
  // DX-145: la cartera (lista de muchos pacientes, sin paciente en el evento)
  // y su descarga en CSV.
  'GET /receivables/aging': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_AGING',
  },
  'GET /receivables/aging.csv': {
    action: 'EXPORT',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_AGING',
  },
  // SEC-043 (M2): los totales de la cartera aproximan lo abonado entre dos
  // consultas; quién los mira queda en la auditoría.
  'GET /receivables/aging/summary': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_AGING_SUMMARY',
  },
  // DX-430: la lista de saldo a favor (dinero de muchos pacientes).
  'GET /receivables/credit-balances': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_CREDIT_BALANCES',
  },
  // DX-146: «Por avisar hoy» (lista de deudores con teléfono e importes).
  'GET /receivables/reminders': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_REMINDERS',
  },
  // DX-204: política de descuentos (solo ADMIN) e informe de descuentos (lista
  // de muchos pacientes, sin paciente en el evento) y su CSV.
  'PUT /discount-policy': { action: 'UPDATE', resource: 'DISCOUNT_POLICY' },
  // DX-253: saldo a favor — traspaso, devolución (con su comprobante) y el
  // tope de recepción. El importe y el motivo quedan en la fila inmutable
  // del movimiento (`resourceId`).
  'POST /treatment-plans/:id/credit-transfers': {
    action: 'CREATE',
    resource: 'PATIENT_CREDIT',
    resourceId: RES,
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'CREDIT_TRANSFER',
  },
  'POST /treatment-plans/:id/credit-refunds': {
    action: 'CREATE',
    resource: 'PATIENT_CREDIT',
    resourceId: RES,
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'CREDIT_REFUND',
  },
  'GET /credit-refunds/:id': {
    action: 'VIEW',
    resource: 'PATIENT_CREDIT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CREDIT_REFUND_RECEIPT',
  },
  'GET /patients/:id/credit-movements': {
    action: 'VIEW',
    resource: 'PATIENT_CREDIT',
    patient: { param: 'id' },
  },
  // DX-279: nueva versión de la política de cancelación de una sede.
  'POST /locations/:id/cancellation-policy': {
    action: 'CREATE',
    resource: 'CANCELLATION_POLICY',
    resourceId: RES,
    reason: 'CANCELLATION_POLICY_CHANGED',
  },
  // DX-316: calendario de la sede (solo ADMIN). La vista previa de la
  // importación no escribe y no se audita.
  'PUT /locations/:id/calendar/working-weekdays': {
    action: 'UPDATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'WORKING_WEEKDAYS_CHANGED',
  },
  'POST /locations/:id/holidays': {
    action: 'CREATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_CREATED',
  },
  'PATCH /locations/:id/holidays/:holidayId': {
    action: 'UPDATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_UPDATED',
  },
  'DELETE /locations/:id/holidays/:holidayId': {
    action: 'DELETE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_DELETED',
  },
  'POST /locations/:id/holidays/import': {
    action: 'CREATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAYS_IMPORTED',
  },
  // DX-291: cargo por inasistencia o cancelación tardía y su condonación
  // (sobre la cita; el motivo de la condonación nunca va a la metadata).
  'POST /appointments/:id/cancellation-fee': {
    action: 'CREATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_CHARGED',
  },
  'POST /appointments/:id/cancellation-fee/waive': {
    action: 'UPDATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_WAIVED',
  },
  // SEC-050: anular un cargo ya generado (con motivo; el texto nunca va a la
  // metadata, el estado antes y después sí).
  'POST /appointments/:id/cancellation-fee/void': {
    action: 'VOID',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_VOIDED',
    statusChange: { from: 'CHARGED', to: 'VOIDED' },
  },
  'GET /reports/discounts': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'DISCOUNT_REPORT',
  },
  'GET /reports/discounts.csv': {
    action: 'EXPORT',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'DISCOUNT_REPORT',
  },
  // DX-399: lo cobrado sin imputar (abonos de muchos pacientes) y su CSV.
  'GET /reports/unallocated-payments': {
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'UNALLOCATED_PAYMENTS',
  },
  'GET /reports/unallocated-payments.csv': {
    action: 'EXPORT',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'UNALLOCATED_PAYMENTS',
  },
  // DX-423: el detalle de una fila lleva el nombre de cada paciente.
  'GET /reports/production-by-procedure/items': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'PRODUCTION_REPORT',
  },
  // DX-558: el detalle del embudo de presupuestos lleva el nombre de cada
  // paciente; su CSV (solo agregados por profesional) sale de la clínica.
  'GET /reports/quote-funnel/presentations': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    reason: 'QUOTE_FUNNEL_REPORT',
  },
  'GET /reports/quote-funnel.csv': {
    action: 'EXPORT',
    resource: 'TREATMENT_PLAN',
    reason: 'QUOTE_FUNNEL_REPORT',
  },
  // DX-172: la captación lleva el nombre de los pacientes que más
  // recomiendan; su CSV (solo agregados por fuente) sale de la clínica. La
  // captación de la ficha, como la ficha.
  'GET /reports/acquisition': {
    action: 'VIEW',
    resource: 'PATIENT',
    reason: 'ACQUISITION_REPORT',
  },
  'GET /reports/acquisition.csv': {
    action: 'EXPORT',
    resource: 'PATIENT',
    reason: 'ACQUISITION_REPORT',
  },
  'GET /patients/:id/acquisition': {
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'PATIENT_ACQUISITION',
  },
  // DX-018: la vista previa y el detalle de una liquidación de honorarios
  // llevan el nombre de cada paciente (la lista, solo cabeceras y totales).
  'GET /commissions/preview': {
    action: 'VIEW',
    resource: 'COMMISSION_SETTLEMENT',
    reason: 'COMMISSION_PREVIEW',
  },
  'GET /commissions/settlements/:id': {
    action: 'VIEW',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'id' },
    reason: 'COMMISSION_SETTLEMENT',
  },
  // DX-464: los PDF de la liquidación y del recibo salen de la clínica.
  'GET /commissions/settlements/:id/pdf': {
    action: 'EXPORT',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'id' },
    reason: 'COMMISSION_SETTLEMENT_PDF',
  },
  'GET /commissions/payments/:paymentId/receipt/pdf': {
    action: 'EXPORT',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'paymentId' },
    reason: 'COMMISSION_RECEIPT_PDF',
  },
  // DX-567: la lista de citas sin tratamiento ligado lleva el nombre de cada
  // paciente; el agregado de la producción agendada, no.
  'GET /reports/scheduled-production/unlinked': {
    action: 'VIEW',
    resource: 'APPOINTMENT',
    reason: 'SCHEDULED_PRODUCTION_REPORT',
  },
  // DX-436: el CSV de «Huecos recuperados» (solo agregados) sale de la
  // clínica: cada descarga queda auditada.
  'GET /reports/recovered-slots.csv': {
    action: 'EXPORT',
    resource: 'APPOINTMENT',
    reason: 'RECOVERED_SLOTS_REPORT',
  },
  // DX-481: el CSV de «Ocupación por sillón» (solo agregados) sale de la
  // clínica: cada descarga queda auditada.
  'GET /reports/chair-occupancy.csv': {
    action: 'EXPORT',
    resource: 'APPOINTMENT',
    reason: 'CHAIR_OCCUPANCY_REPORT',
  },
  // DX-556: la lista, el tablero y la ficha de los prospectos llevan nombres y
  // teléfonos; el contador, el informe (solo números) y los responsables, no.
  'GET /leads': { action: 'VIEW', resource: 'LEAD', reason: 'LEAD_LIST' },
  'GET /leads/board': {
    action: 'VIEW',
    resource: 'LEAD',
    reason: 'LEAD_BOARD',
  },
  'GET /leads/:id': {
    action: 'VIEW',
    resource: 'LEAD',
    resourceId: { param: 'id' },
    reason: 'LEAD_VIEWED',
  },
  // DX-556: la retención de los perdidos (configuración, solo ADMIN) y los
  // motivos propios (sin resourceId: el id de un motivo no es un prospecto).
  'PUT /leads/settings': {
    action: 'UPDATE',
    resource: 'LEAD',
    reason: 'LEAD_RETENTION_UPDATED',
  },
  'POST /lead-reasons': {
    action: 'CREATE',
    resource: 'LEAD',
    reason: 'LEAD_REASON_ADDED',
  },
  'DELETE /lead-reasons/:id': {
    action: 'DELETE',
    resource: 'LEAD',
    reason: 'LEAD_REASON_REMOVED',
  },
  // DX-566: la lista de llamadas de control postoperatorio lleva el nombre y
  // el teléfono de cada paciente; el contador, no.
  'GET /post-op-checks': {
    action: 'VIEW',
    resource: 'POST_OP_CHECK',
    reason: 'POST_OP_CHECK_LIST',
  },
  // DX-439: «Pendiente de cerrar» lleva los nombres de muchos pacientes.
  'GET /closing-queue': {
    action: 'VIEW',
    resource: 'APPOINTMENT',
    reason: 'CLOSING_QUEUE',
  },
  // DX-339: agenda de contingencia (PDF con nombres y teléfonos de los
  // pacientes de hoy y mañana de la sede): cada descarga, con la sede.
  'GET /locations/:locationId/contingency-agenda': {
    action: 'EXPORT',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CONTINGENCY_AGENDA_DOWNLOADED',
  },
  'GET /locations/:locationId/contingency-agenda/nightly/pdf': {
    action: 'EXPORT',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CONTINGENCY_AGENDA_NIGHTLY_DOWNLOADED',
  },
  // DX-405: la copia sin conexión de la agenda (mismos datos que el PDF) sale
  // al navegador: cada lectura, con la sede.
  'GET /locations/:locationId/contingency-agenda/offline': {
    action: 'EXPORT',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CONTINGENCY_AGENDA_OFFLINE_SYNCED',
  },
  // DX-015: recall. La lista (con teléfonos) se audita sin paciente; el
  // contacto, sin la nota; fijar o pausar el recall, con el paciente.
  'GET /recall/due': { action: 'VIEW', resource: 'PATIENT_RECALL' },
  // DX-015-bis (D17): «Sin recall configurado», con teléfonos: como la de
  // vencidos, sin paciente y con su `reason`.
  'GET /recall/unconfigured': {
    action: 'VIEW',
    resource: 'PATIENT_RECALL',
    reason: 'RECALL_UNCONFIGURED',
  },
  'POST /recall/:recallId/contacts': {
    action: 'CREATE',
    resource: 'RECALL_CONTACT',
    resourceId: RES,
    patient: { response: 'patientId' },
  },
  'GET /patients/:id/recalls': {
    action: 'VIEW',
    resource: 'PATIENT_RECALL',
    patient: { param: 'id' },
  },
  'PUT /patients/:id/recalls/:kind': {
    action: 'UPDATE',
    resource: 'PATIENT_RECALL',
    patient: { param: 'id' },
  },
  // DX-150: cobranza. La nota se audita sin su texto (solo los nombres de los
  // campos); el cambio de estado del compromiso lo audita SettlePaymentPromises.
  'POST /patients/:id/collection-notes': {
    action: 'CREATE',
    resource: 'COLLECTION_NOTE',
    resourceId: RES,
    patient: { param: 'id' },
  },
  // DX-146: «Marcar avisado» (nota REMINDER_SENT), sin texto ni importes.
  'POST /patients/:id/balance-reminders': {
    action: 'CREATE',
    resource: 'COLLECTION_NOTE',
    resourceId: RES,
    patient: { param: 'id' },
    reason: 'BALANCE_REMINDER',
  },
  'POST /patients/:id/payment-promises': {
    action: 'CREATE',
    resource: 'PAYMENT_PROMISE',
    resourceId: RES,
    patient: { param: 'id' },
  },
  'GET /patients/:id/collections': {
    action: 'VIEW',
    resource: 'PAYMENT_PROMISE',
    patient: { param: 'id' },
    reason: 'PATIENT_COLLECTIONS',
  },

  // DX-027: caja por turno (sin paciente: el turno es de un usuario y una
  // sede). Los ajustes de caja de la clínica van como UPDATE con su motivo.
  'PUT /cash-sessions/settings': {
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    reason: 'CASH_SETTINGS',
  },
  'GET /cash-sessions/current': {
    action: 'VIEW',
    resource: 'CASH_SESSION',
    reason: 'CASH_SESSION_CURRENT',
  },
  'POST /cash-sessions/open': {
    action: 'CREATE',
    resource: 'CASH_SESSION',
    resourceId: RES,
  },
  'GET /cash-sessions': { action: 'VIEW', resource: 'CASH_SESSION' },
  'GET /cash-sessions/:id': {
    action: 'VIEW',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
  },
  'POST /cash-sessions/:id/close': {
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_CLOSED',
  },
  'POST /cash-sessions/:id/reopen': {
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_REOPENED',
  },
  'POST /cash-sessions/:id/adjustments': {
    action: 'CREATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_ADJUSTMENT',
  },

  // DX-274: gastos de la sede (sin paciente). Los pagos, las anulaciones y el
  // soporte van como escrituras sobre el gasto, con su motivo; la metadata
  // lleva los NOMBRES de los campos, nunca el proveedor ni la descripción.
  'GET /expenses': { action: 'VIEW', resource: 'EXPENSE' },
  'GET /expenses/summary': {
    action: 'VIEW',
    resource: 'EXPENSE',
    reason: 'EXPENSE_SUMMARY',
  },
  'GET /expenses/summary.csv': {
    action: 'EXPORT',
    resource: 'EXPENSE',
    reason: 'EXPENSE_SUMMARY',
  },
  // DX-411: cuentas por pagar por proveedor, su CSV y el detalle.
  'GET /expenses/payables': {
    action: 'VIEW',
    resource: 'EXPENSE',
    reason: 'EXPENSE_PAYABLES',
  },
  'GET /expenses/payables.csv': {
    action: 'EXPORT',
    resource: 'EXPENSE',
    reason: 'EXPENSE_PAYABLES',
  },
  'GET /expenses/payables/expenses': {
    action: 'VIEW',
    resource: 'EXPENSE',
    reason: 'EXPENSE_PAYABLES',
  },
  'GET /expenses.csv': {
    action: 'EXPORT',
    resource: 'EXPENSE',
    reason: 'EXPENSE_LIST',
  },
  'POST /expenses': {
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: RES,
  },
  'GET /expenses/:id': {
    action: 'VIEW',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
  },
  'PATCH /expenses/:id': {
    action: 'UPDATE',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
  },
  'POST /expenses/:id/void': {
    action: 'VOID',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
    reason: 'EXPENSE_VOIDED',
  },
  'POST /expenses/:id/payments': {
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
    reason: 'PAYMENT_ADDED',
  },
  'POST /expenses/:id/payments/:paymentId/void': {
    action: 'VOID',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
    reason: 'PAYMENT_VOIDED',
  },
  'POST /cash-sessions/current/outflows': {
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: RES,
    reason: 'CASH_OUTFLOW',
  },
  'POST /expenses/:id/attachment': {
    action: 'UPDATE',
    resource: 'EXPENSE',
    resourceId: { param: 'id' },
    reason: 'EXPENSE_RECEIPT_ATTACHED',
  },
  'POST /expense-categories': {
    action: 'CREATE',
    resource: 'EXPENSE',
    reason: 'EXPENSE_CATEGORY_ADDED',
  },
  'DELETE /expense-categories/:id': {
    action: 'DELETE',
    resource: 'EXPENSE',
    reason: 'EXPENSE_CATEGORY_REMOVED',
  },

  // DX-122: bloqueos de agenda (sin paciente). Las altas y bajas de
  // «Pendientes por agendar» las audita el caso de uso, con el paciente.
  'POST /schedule-blocks': {
    action: 'CREATE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: RES,
  },
  'PATCH /schedule-blocks/:id': {
    action: 'UPDATE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: { param: 'id' },
  },
  'DELETE /schedule-blocks/:id': {
    action: 'DELETE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: { param: 'id' },
  },

  // DX-211: sillones de cada sede (sin paciente). No se borran: se desactivan.
  'POST /chairs': {
    action: 'CREATE',
    resource: 'CHAIR',
    resourceId: RES,
  },
  'PATCH /chairs/:id': {
    action: 'UPDATE',
    resource: 'CHAIR',
    resourceId: { param: 'id' },
  },
  'PUT /chairs/order': {
    action: 'UPDATE',
    resource: 'CHAIR',
    reason: 'CHAIR_ORDER',
  },
  'POST /chairs/:id/deactivate': {
    action: 'UPDATE',
    resource: 'CHAIR',
    resourceId: { param: 'id' },
    reason: 'CHAIR_DEACTIVATED',
  },
  'POST /chairs/:id/reactivate': {
    action: 'UPDATE',
    resource: 'CHAIR',
    resourceId: { param: 'id' },
    reason: 'CHAIR_REACTIVATED',
  },

  // DX-542: equipos biomédicos (sin paciente). No se borran: se dan de baja;
  // los mantenimientos se anulan con motivo.
  'POST /equipment': {
    action: 'CREATE',
    resource: 'EQUIPMENT',
    resourceId: RES,
  },
  'PATCH /equipment/:id': {
    action: 'UPDATE',
    resource: 'EQUIPMENT',
    resourceId: { param: 'id' },
  },
  'POST /equipment/:id/retire': {
    action: 'UPDATE',
    resource: 'EQUIPMENT',
    resourceId: { param: 'id' },
    reason: 'EQUIPMENT_RETIRED',
  },
  'POST /equipment/:id/maintenances': {
    action: 'CREATE',
    resource: 'EQUIPMENT_MAINTENANCE',
    resourceId: RES,
  },
  'POST /equipment/:id/maintenances/:maintenanceId/void': {
    action: 'VOID',
    resource: 'EQUIPMENT_MAINTENANCE',
    resourceId: { param: 'maintenanceId' },
  },

  // DX-048: un ADMIN desbloquea el inicio de sesión de un miembro.
  'POST /staff/:userId/login-unlock': {
    action: 'UPDATE',
    resource: 'STAFF_MEMBER',
    resourceId: { param: 'userId' },
    reason: 'LOGIN_UNLOCKED',
  },

  // DX-170: plantillas de evolución (sin paciente: no llevan sus datos).
  // Desactivar es un PATCH con `active` en `changedFields`.
  'POST /clinical-note-templates': {
    action: 'CREATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    resourceId: RES,
  },
  'POST /clinical-note-templates/samples': {
    action: 'CREATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    reason: 'SAMPLE_TEMPLATES',
  },
  'PATCH /clinical-note-templates/:id': {
    action: 'UPDATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    resourceId: { param: 'id' },
  },
  // DX-222: plantillas de indicaciones postoperatorias (sin paciente). Ni el
  // texto ni los vínculos van a la auditoría; desactivar es un PATCH.
  'POST /post-op-templates': {
    action: 'CREATE',
    resource: 'POSTOP_TEMPLATE',
    resourceId: RES,
  },
  'POST /post-op-templates/samples': {
    action: 'CREATE',
    resource: 'POSTOP_TEMPLATE',
    reason: 'SAMPLE_TEMPLATES',
  },
  'PATCH /post-op-templates/:id': {
    action: 'UPDATE',
    resource: 'POSTOP_TEMPLATE',
    resourceId: { param: 'id' },
  },
  // DX-222: entregas de indicaciones. Ver las de una cita (el paciente sale
  // de la respuesta) y las de la ficha. Registrar una la audita el caso de
  // uso (CREATE con el canal en `reason`). Nunca el texto.
  'GET /appointments/:appointmentId/post-op-instructions': {
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    patient: { response: 'patientId' },
  },
  'GET /patients/:patientId/post-op-deliveries': {
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    patient: P,
  },
  'GET /patients/:patientId/post-op-deliveries/:id': {
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    resourceId: { param: 'id' },
    patient: P,
  },
  // DX-374: alta de una tasa de cambio manual (solo ADMIN); el id de la tasa.
  'POST /exchange/manual-rates': {
    action: 'CREATE',
    resource: 'EXCHANGE_RATE',
    resourceId: RES,
  },
  // DX-375: corregir una tasa manual sin usar (solo ADMIN); el id de la ruta.
  'PUT /exchange/manual-rates/:id': {
    action: 'UPDATE',
    resource: 'EXCHANGE_RATE',
    resourceId: { param: 'id' },
  },
  // DX-101: crear el enlace de acceso del paciente; ni la URL ni el token.
  'POST /patients/:id/access-links': {
    action: 'CREATE',
    resource: 'PATIENT_ACCESS_LINK',
    resourceId: RES,
    patient: { param: 'id' },
    reason: 'PATIENT_ACCESS_LINK_CREATED',
  },
  // DX-569: crear (y enviar) el enlace de pago; ni la URL ni el token.
  'POST /patients/:id/payment-links': {
    action: 'CREATE',
    resource: 'PAYMENT_LINK',
    resourceId: RES,
    patient: { param: 'id' },
    reason: 'PAYMENT_LINK_CREATED',
  },
  // DX-377: alta y cambio de un medio de pago de la clínica (solo ADMIN).
  'POST /payment-methods': {
    action: 'CREATE',
    resource: 'PAYMENT_METHOD',
    resourceId: RES,
  },
  'PATCH /payment-methods/:id': {
    action: 'UPDATE',
    resource: 'PAYMENT_METHOD',
    resourceId: { param: 'id' },
  },
  // SEC-009: verificar (cambia el ruteo) y eliminar un dominio personalizado.
  'POST /domains/:id/verify': {
    action: 'UPDATE',
    resource: 'TENANT_DOMAIN',
    resourceId: { param: 'id' },
    reason: 'DOMAIN_VERIFICATION',
  },
  'DELETE /domains/:id': {
    action: 'DELETE',
    resource: 'TENANT_DOMAIN',
    resourceId: { param: 'id' },
  },
};

/**
 * Rutas que auditan desde el CASO DE USO (RecordAuditEventUseCase), no con
 * `@Audit`: el decorador no sabe leer lo que necesitan. Cada una cita qué
 * spec prueba su evento. Tienen que existir y no llevar además `@Audit`
 * (sería un evento doble).
 */
const AUDITED_IN_USE_CASE: Record<string, string> = {
  // DX-172: el catálogo «¿Cómo nos conoció?» (CREATE/UPDATE CLINIC_SETTINGS,
  // PATIENT_SOURCE_CREATED/UPDATED, antes y después; sin evento si nada
  // cambia), en la transacción del guardado.
  'POST /patient-sources': 'patient-acquisition.e2e-spec.ts',
  'PATCH /patient-sources/:id': 'patient-acquisition.e2e-spec.ts',
  // DX-562: citas en serie. UN evento por operación, escrito en su
  // transacción: CREATE APPOINTMENT APPOINTMENT_SERIES_CREATED (la serie, sus
  // citas, sus fechas y el intervalo), UPDATE APPOINTMENT
  // APPOINTMENT_SERIES_CANCELLED (las citas canceladas y la cancelación de la
  // primera) y APPOINTMENT_SERIES_MOVED (las citas, sus nuevas fechas y el
  // movimiento de la pivote). Nunca el motivo ni las notas.
  'POST /appointments/series':
    'appointment-series.use-case.spec.ts, appointment-series.int-spec.ts y appointment-series.e2e-spec.ts',
  'POST /appointments/series/:id/cancel':
    'appointment-series.int-spec.ts y appointment-series.e2e-spec.ts',
  'POST /appointments/series/:id/move':
    'appointment-series.int-spec.ts y appointment-series.e2e-spec.ts',
  // DX-556: prospectos. Alta (CREATE LEAD), edición (UPDATE con los nombres
  // de campo), etapa (UPDATE con la etapa antes y después), nota (UPDATE sin
  // el texto) y conversión (CREATE PATIENT + UPDATE LEAD, LEAD_CONVERTED o
  // LEAD_LINKED), en la transacción de cada escritura; nunca el nombre, el
  // teléfono ni las notas.
  'POST /leads': 'leads.int-spec.ts y leads.e2e-spec.ts',
  'PATCH /leads/:id': 'leads.e2e-spec.ts',
  'POST /leads/:id/stage': 'leads.int-spec.ts y leads.e2e-spec.ts',
  'POST /leads/:id/notes': 'leads.e2e-spec.ts',
  'POST /leads/:id/convert': 'leads.int-spec.ts y leads.e2e-spec.ts',
  // DX-561: ajustes del seguimiento automático por sede (UPDATE
  // CLINIC_SETTINGS, QUOTE_FOLLOW_UP_SETTINGS_UPDATED, antes y después; sin
  // evento si nada cambia), en la transacción del guardado.
  'PUT /quote-follow-up-settings/:locationId': 'quote-follow-up.e2e-spec.ts',
  // DX-566: el intento de llamada del control postoperatorio (UPDATE
  // POST_OP_CHECK con el resultado como motivo, el cambio de estado y dónde
  // quedó en la historia; nunca la nota), en la transacción del cierre.
  'POST /post-op-checks/:id/attempts':
    'post-op-checks.int-spec.ts y post-op-checks.e2e-spec.ts',
  // DX-017: laboratorio dental. El catálogo (DENTAL_LAB con los nombres de
  // los campos y, al desactivar, el estado) y la orden: edición (los campos
  // y la fecha prometida antes y después), envío, recepción, revisión
  // (statusChange), anulación (VOID, sin el motivo) e impresión (PRINT).
  'POST /dental-labs': 'dental-lab-orders.e2e-spec.ts',
  'PATCH /dental-labs/:labId': 'dental-lab-orders.e2e-spec.ts',
  'POST /dental-labs/:labId/services': 'dental-lab-orders.e2e-spec.ts',
  'PATCH /dental-labs/:labId/services/:serviceId':
    'dental-lab-orders.e2e-spec.ts',
  'PATCH /lab-orders/:id': 'dental-lab-orders.e2e-spec.ts',
  'POST /lab-orders/:id/send': 'dental-lab-orders.e2e-spec.ts',
  'POST /lab-orders/:id/receive': 'dental-lab-orders.e2e-spec.ts',
  'POST /lab-orders/:id/check': 'dental-lab-orders.e2e-spec.ts',
  'POST /lab-orders/:id/cancel': 'dental-lab-orders.e2e-spec.ts',
  // DX-190: el cambio de estado del caso (UPDATE ORTHO_CASE ORTHO_CASE_STATUS
  // con el estado antes y después, sin el motivo) y los ajustes de la clínica
  // (CLINIC_SETTINGS ORTHODONTICS_SETTINGS con los campos que cambiaron).
  'POST /patients/:patientId/ortho-cases/:caseId/status':
    'orthodontics.e2e-spec.ts',
  'PUT /ortho/settings': 'orthodontics.e2e-spec.ts',
  // DX-285: el honorario (ORTHO_FEE_UPDATED con los nombres de lo que
  // cambió, nunca importes) y su aceptación (ORTHO_FEE_ACCEPTED con el plan).
  'PUT /patients/:patientId/ortho-cases/:caseId/fee':
    'ortho-billing.e2e-spec.ts',
  'POST /patients/:patientId/ortho-cases/:caseId/fee/accept':
    'ortho-billing.e2e-spec.ts',
  // DX-266: la fusión (PATIENT_MERGED en cada paciente, con lo movido por
  // tabla) y «No es duplicado» (PATIENT_DUPLICATE_DISMISSED en los dos), en
  // la transacción del cambio.
  'POST /patient-duplicates/merge':
    'patient-merge.e2e-spec.ts y patient-merge.int-spec.ts',
  'POST /patient-duplicates/dismissals': 'patient-merge.e2e-spec.ts',
  // DX-569: datos para pagar de un medio, como configuración (DX-360) sin
  // sus valores, en la transacción del cambio.
  'PUT /payment-methods/:id/instructions': 'payment-links.e2e-spec.ts',
  'DELETE /payment-methods/:id/instructions/:instructionId':
    'payment-links.e2e-spec.ts',
  // DX-101: el acceso verificado (VIEW) y el bloqueo al quinto fallo
  // (UPDATE), actor público PUBLIC_LINK, en la transacción del contador;
  // confirmar una cita desde el portal deja el evento del flujo de DX-005
  // (CONFIRMATION_LINK_CONFIRMED) en la transacción de la respuesta.
  'DELETE /patients/:id/access-links/:linkId':
    'patient-access.e2e-spec.ts (solo si revoca: revocar otra vez no deja evento)',
  'POST /public/patient-access/:token/verify':
    'patient-access.int-spec.ts y patient-access.e2e-spec.ts',
  'POST /public/patient-access/me/appointments/:appointmentId/confirm':
    'patient-access.e2e-spec.ts',
  // DX-101-bis: aceptar un presupuesto desde el portal: SIGN de
  // TREATMENT_PLAN, actor paciente (sin usuario), PUBLIC_LINK y
  // PORTAL_QUOTE_ACCEPTED, en la transacción de la aceptación.
  'POST /public/patient-access/me/plans/:planId/accept':
    'patient-portal-accept.int-spec.ts y patient-access.e2e-spec.ts',
  // DX-569: el reporte del paciente (actor público, PUBLIC_LINK) en la
  // transacción que gasta el enlace; confirmar (UPDATE del reporte y CREATE
  // del abono) en la del abono; rechazar en la del rechazo.
  'POST /public/payment-links/:token/report':
    'payment-links.int-spec.ts y payment-links.e2e-spec.ts',
  'POST /payment-reports/:id/confirm':
    'payment-links.int-spec.ts y payment-links.e2e-spec.ts',
  'POST /payment-reports/:id/reject': 'payment-links.e2e-spec.ts',
  // DX-399: PAYMENT_ALLOCATION / PAYMENT_REALLOCATED con las líneas antes y
  // después, en la MISMA transacción del cambio (si algo falla, se deshacen juntos).
  'PUT /payments/:id/allocations': 'payment-reallocation.e2e-spec.ts',
  // DX-222: CREATE POSTOP_DELIVERY con el id de `delivery` y el canal como
  // `reason`; queda auditada aunque el email no se pueda encolar.
  'POST /appointments/:appointmentId/post-op-instructions/deliveries':
    'post-op-deliveries.use-cases.spec.ts y post-op-deliveries.e2e-spec.ts',
  // DX-233: PROVIDER_SCHEDULE con los tramos antes y después
  // (`scheduleChange`), que el interceptor no conoce.
  'PUT /providers/:providerId/schedule':
    'provider-schedule.use-cases.spec.ts y provider-schedule.e2e-spec.ts',
  'POST /providers/:providerId/schedule-overrides':
    'provider-schedule.use-cases.spec.ts y provider-schedule.e2e-spec.ts',
  'DELETE /providers/:providerId/schedule-overrides/:overrideId':
    'provider-schedule.e2e-spec.ts',
  'PUT /schedule/settings': 'provider-schedule.e2e-spec.ts',
  // DX-328: CLINIC_SETTINGS con MAJORITY_AGE_SETTINGS; sin evento si no cambia.
  'PUT /patients/settings':
    'patient-settings.use-cases.spec.ts y patient-settings.e2e-spec.ts',
  // DX-497: CLINIC_SETTINGS con PATIENT_LANGUAGES_SETTINGS y la lista antes y después; sin evento si no cambia.
  'PUT /patients/languages':
    'patient-languages.use-cases.spec.ts y patient-languages.e2e-spec.ts',
  // DX-330: CLINIC_SETTINGS con CLINICAL_RECORD_RETENTION_SETTINGS y `retentionTermChange`, en la transacción del cambio; sin evento si no cambia.
  'PUT /patients/retention/settings':
    'retention-settings.use-cases.spec.ts y clinical-record-retention.e2e-spec.ts',
  // DX-327: CLINIC_SETTINGS con DOCUMENT_TYPE_NAMES_SETTINGS y los tipos cambiados; sin evento si no cambia.
  'PUT /patients/document-type-names':
    'document-type-names.use-cases.spec.ts y document-type-names.e2e-spec.ts',
  // DX-128: COMMUNICATION_PREFERENCES_CHANGED con los campos cambiados.
  'PATCH /patients/:id/communication':
    'patient-communication.use-cases.spec.ts y patient-communication.e2e-spec.ts',
  // Vigencia de la anamnesis: CLINIC_SETTINGS con ANAMNESIS_VALIDITY_SETTINGS.
  'PUT /medical-history/settings':
    'medical-alerts.spec.ts y appointments-medical-alerts.e2e-spec.ts',
  // DX-540: CLINIC_SETTINGS con CLINICAL_ENTRY_LICENSE_WARNING (OFF/ON); sin evento si no cambia.
  'PUT /clinical-entries/settings':
    'clinical-entry-license.use-cases.spec.ts y clinical-entry-license.e2e-spec.ts',
  // APPOINTMENT_PLAN_ITEMS en cada cita, en la transacción del traspaso.
  'POST /appointments/:id/plan-items/:planItemId/claim':
    'plan-items-arrival.e2e-spec.ts',
  // DX-200: ARRIVAL_UNDONE con el estado al que vuelve.
  'POST /appointments/:id/undo-arrival':
    'patient-flow.use-case.spec.ts y patient-flow.e2e-spec.ts',
  // DX-470: WALK_IN_PATIENT, WALK_IN_ARRIVAL y WALK_IN_OVERBOOK en la misma
  // transacción que el alta y la cita (todo o nada).
  'POST /appointments/walk-in': 'walk-in.int-spec.ts y walk-in.e2e-spec.ts',
  // Adelantar al hueco: APPOINTMENT_MOVED, como cualquier reagendado.
  'PATCH /appointments/:id/opening': 'update-appointment.use-case.spec.ts',
  // Lista de espera: WAITLIST_MANUAL, WAITLIST_DISMISSED y WAITLIST_SCHEDULED.
  'POST /waitlist': 'waitlist.use-cases.spec.ts',
  'POST /waitlist/:id/dismiss': 'waitlist.use-cases.spec.ts',
  'POST /waitlist/:id/schedule': 'waitlist.use-cases.spec.ts',
  // Ofertas de huecos: WAITLIST_OFFER al crearla y OFFER_<resultado>.
  'POST /appointments/openings/:locationId/offers':
    'opening-candidates.use-cases.spec.ts',
  'PATCH /appointments/openings/offers/:id':
    'opening-candidates.use-cases.spec.ts',
  // PASSWORD_RESET de SESSION (sin sesión: el actor es el titular).
  'POST /auth/reset-password':
    'reset-password.use-case.spec.ts y password-reset.e2e-spec.ts',
  // REMINDER_OPT_OUT del paciente por el enlace (solo si de verdad se da de baja).
  'POST /public/reminder-opt-outs/:token':
    'reminder-opt-out.use-cases.spec.ts y reminder-opt-out.e2e-spec.ts',
  // DX-243: el paciente por el enlace, en la transacción de cada paso:
  // SIGNATURE_LINK_OPENED y SIGNATURE_CODE_SENT al pedir el código,
  // SIGNATURE_CODE_VERIFIED o SIGNATURE_LINK_LOCKED al verificarlo y
  // SIGNATURE_PATIENT_SIGNED al firmar (con el consentimiento).
  'POST /public/sign/:token/code': 'signature-requests.e2e-spec.ts',
  'POST /public/sign/:token/verify': 'signature-requests.e2e-spec.ts',
  'POST /public/sign/:token/sign': 'signature-requests.e2e-spec.ts',
  // DX-435: aceptar y rechazar la oferta de hueco desde el enlace (UPDATE de
  // WAITLIST_OFFER, origen PUBLIC_LINK, en la transacción del repositorio).
  'POST /public/slot-offers/:token/accept': 'slot-offers.int-spec.ts',
  'POST /public/slot-offers/:token/decline': 'slot-offers.int-spec.ts',
  // DX-443: descargar la copia del PDF firmado desde el enlace (EXPORT de
  // CONSENT, origen PUBLIC_LINK, sin actor, en la transacción que gasta el
  // enlace).
  'POST /public/signed-consent-copies/:token/download':
    'signed-pdf-copies.int-spec.ts',
  // DX-361: confirmación de cita por enlace, en la transacción de la
  // escritura y sin token, hash ni URL. Recepción: UPDATE APPOINTMENT origen
  // STAFF, CONFIRMATION_LINK_CREATED o _RESENT; el paciente (sin usuario):
  // origen LINK, CONFIRMATION_LINK_CONFIRMED, _CANCELLED o _CALL_REQUESTED.
  'POST /appointments/:id/confirmation-link':
    'confirmation-audit.spec.ts, create-confirmation-link.use-case.spec.ts, appointment-confirmations-audit.int-spec.ts y appointment-confirmations.e2e-spec.ts',
  'POST /public/appointment-confirmations/:token':
    'confirmation-audit.spec.ts, respond-confirmation.use-case.spec.ts, appointment-confirmations-audit.int-spec.ts y appointment-confirmations.e2e-spec.ts',
  // DX-437: el paciente pide (o quita) «Avisarme si se libera un hueco antes»; auditado en el repositorio, origen PUBLIC_LINK.
  'POST /public/appointment-confirmations/:token/wants-earlier':
    'confirmation-audit.spec.ts y appointment-confirmations.e2e-spec.ts',
  // ANAMNESIS_SUBMITTED (y el consentimiento) en la transacción del envío.
  'POST /public/medical-history/:token':
    'medical-history-submissions.e2e-spec.ts',
  // Plataforma: JOB_RETRIED en `platform_audit_events`, no en `audit_events`.
  'POST /platform/jobs/:id/retry': 'jobs-platform.e2e-spec.ts',
  // DX-515: el repositorio escribe el evento en la transacción del cambio,
  // con el antes y el después (configAuditEvent); sin evento si no cambia.
  // CLINIC_SETTINGS RECEIPT_SETTINGS, LOCATION RECEIPT_LEGEND y PAYMENT
  // EXTERNAL_INVOICE_NUMBER (este, con el paciente del abono).
  'PUT /payment-receipts/settings': 'receipt-settings.e2e-spec.ts',
  'PUT /payment-receipts/settings/locations/:locationId':
    'receipt-settings.e2e-spec.ts',
  'PUT /payments/:id/external-invoice-number': 'receipt-settings.e2e-spec.ts',
  // DX-432: PATIENT_CREDIT POLICY con el tope de recepción antes y después
  // (configAuditEvent), en la transacción del cambio; sin evento si no cambia.
  'PUT /patient-credit/policy': 'patient-credit.e2e-spec.ts',
  // DX-517: CLINIC_SETTINGS CURRENCY_TEXTS con el antes y el después
  // («VES=Bs.»), en la transacción del cambio; sin evento si no cambia.
  'PUT /exchange/currency-texts': 'currency-texts.e2e-spec.ts',
  // DX-019: CLINIC_SETTINGS CLINIC_PROFILE (datos de la clínica) y
  // CLINIC_LOGO (clave del logo) con el antes y el después, en la
  // transacción del cambio; sin evento si nada cambia.
  'PATCH /clinic/settings': 'clinic-settings.e2e-spec.ts',
  // DX-091: CLINIC_SETTINGS FINANCIAL_LOCK con el antes y el después
  // (configAuditEvent), en la transacción del cambio; sin evento si no cambia.
  'PATCH /clinic/settings/financial-lock': 'financial-lock.e2e-spec.ts',
  // DX-018: la regla de honorarios como CLINIC_SETTINGS COMMISSION_RULE con
  // el antes y el después (base, modo, % y categorías; sin importes), y el
  // cierre de la liquidación como CREATE COMMISSION_SETTLEMENT (período,
  // base y nº de líneas) más el cierre contable que sube (CLINIC_SETTINGS
  // FINANCIAL_LOCK), en la transacción del cierre.
  'PUT /commissions/rules/:userId': 'commissions.e2e-spec.ts',
  'POST /commissions/settlements': 'commissions.e2e-spec.ts',
  // DX-464: el pago (CREATE COMMISSION_PAYMENT_CREATED de la liquidación y
  // CREATE del gasto) y su anulación (VOID de los dos) en la transacción del
  // gasto; pedir la conformidad (SEND, sin URL ni token) en la de su enlace;
  // la firma del profesional (SIGN, actor = su usuario sin rol, origen LINK)
  // en la de la firma. Sin importes.
  'POST /commissions/settlements/:id/payments':
    'commission-payments.int-spec.ts y commission-payments.e2e-spec.ts',
  'POST /commissions/payments/:paymentId/void':
    'commission-payments.int-spec.ts y commission-payments.e2e-spec.ts',
  'POST /commissions/payments/:paymentId/receipt-request':
    'commission-payments.e2e-spec.ts',
  'POST /public/commission-receipts/:token/sign':
    'commission-payments.e2e-spec.ts',
  'POST /clinic/settings/logo': 'clinic-settings.e2e-spec.ts',
  'DELETE /clinic/settings/logo': 'clinic-settings.e2e-spec.ts',
  // DX-324: CLINIC_SETTINGS con PRESCRIPTION_SETTINGS, los campos cambiados
  // y el antes y el después en códigos RX; sin evento si nada cambió.
  'PUT /prescriptions/settings':
    'prescription-settings.use-cases.spec.ts y prescription-settings.e2e-spec.ts',
  // DX-306: CLINIC_SETTINGS con CERTIFICATE_SETTINGS y los campos cambiados;
  // sin evento si nada cambió.
  'PUT /certificates/settings':
    'patient-certificates.use-cases.spec.ts y patient-certificates.e2e-spec.ts',
  // DX-456: EXPORT · PATIENT · CLINICAL_RECORD_COPY_GENERATED con `copyId`,
  // período y códigos de las secciones, en la MISMA transacción que la
  // generación (nunca el «entregado a»).
  'POST /patients/:patientId/clinical-record-copies':
    'clinical-record-copies.int-spec.ts y clinical-record-copies.e2e-spec.ts',
  // DX-379: CLINIC_SETTINGS con QUOTE_SETTINGS, el campo cambiado y el antes
  // y el después en códigos QT; sin evento si nada cambió.
  'PUT /treatment-plan-settings':
    'quote-settings.use-cases.spec.ts y treatment-plan-quote-validity.e2e-spec.ts',
  // DX-448: CLINIC_SETTINGS con SLOT_OFFER_SETTINGS y configChange antes y
  // después, escrito por el repositorio en la transacción, sin sede (DX-363);
  // sin evento si nada cambió.
  'PUT /slot-offer-settings': 'slot-offer-settings.e2e-spec.ts',
  // DX-016: la reserva online se audita en el repositorio, en su transacción.
  'POST /public/booking/verification': 'online-booking.e2e-spec.ts',
  'POST /public/booking/verification/:id/verify': 'online-booking.e2e-spec.ts',
  'POST /public/booking': 'online-booking.e2e-spec.ts',
  'PUT /online-booking/settings': 'online-booking.e2e-spec.ts',
  'PUT /online-booking/types/:appointmentTypeId': 'online-booking.e2e-spec.ts',
  'POST /online-booking/requests/:id/accept': 'online-booking.e2e-spec.ts',
  'POST /online-booking/requests/:id/decline': 'online-booking.e2e-spec.ts',
  // DX-568: CLINIC_SETTINGS con WEEKLY_DIGEST_SETTINGS y configChange antes y
  // después (destinatarios incluidos), escrito por el repositorio en la
  // transacción, sin sede; sin evento si nada cambió. La prueba: VIEW de
  // CLINIC_SETTINGS (WEEKLY_DIGEST_TEST_SENT) en la transacción que encola el
  // email. La baja por enlace: UPDATE de CLINIC_SETTINGS
  // (WEEKLY_DIGEST_UNSUBSCRIBED, origen LINK) con la persona del enlace de
  // actor, solo si de verdad salió de la lista.
  'PUT /clinic/weekly-digest-settings': 'weekly-digest.e2e-spec.ts',
  'POST /clinic/weekly-digest/send-test': 'weekly-digest.e2e-spec.ts',
  'POST /public/weekly-digest-unsubscribe/:token': 'weekly-digest.e2e-spec.ts',
  // DX-565: CLINIC_SETTINGS con MESSAGE_TEMPLATE_UPDATED (CREATE o UPDATE con
  // el asunto antes/después y del cuerpo, oculto, su longitud y huella) y
  // MESSAGE_TEMPLATE_RESET (DELETE con el antes), escritos por el
  // repositorio en la transacción, sin sede; sin evento si nada cambió. La
  // prueba: VIEW de CLINIC_SETTINGS (MESSAGE_TEMPLATE_TEST_SENT) en la
  // transacción que encola el email.
  'PUT /message-templates/:key/:channel/:language':
    'message-templates.e2e-spec.ts',
  'DELETE /message-templates/:key/:channel/:language':
    'message-templates.e2e-spec.ts',
  'POST /message-templates/:key/:channel/:language/test':
    'message-templates.e2e-spec.ts',
  // DX-146: CLINIC_SETTINGS con BALANCE_REMINDER_POLICY y configChange antes
  // y después, escrito por el repositorio en la transacción, sin sede; sin
  // evento si nada cambió.
  'PUT /receivables/reminder-policy': 'receivables-reminders.e2e-spec.ts',
  // DX-374: CLINIC_SETTINGS con EXCHANGE_RATE_SOURCE y el antes y el después;
  // sin evento si no cambia. DX-384: el plazo de la última tasa registrada
  // deja EXCHANGE_RATE_MAX_AGE con configChange antes/después, escrito por el
  // repositorio en la misma transacción.
  'PUT /exchange/settings':
    'exchange-rate-settings.use-cases.spec.ts y exchange-rate-source.e2e-spec.ts',
  // DX-274: VIEW si se abre en el navegador, EXPORT si se descarga (la acción
  // depende de la query, que el decorador no lee).
  'GET /expenses/:id/attachment/url':
    'expense-receipts.use-cases.spec.ts y expenses.e2e-spec.ts',
  // DX-389: VIEW si se abre en el navegador, EXPORT si se descarga (como el
  // soporte del gasto); la metadata no lleva datos del paciente.
  'GET /payments/:id/proof/url':
    'payment-proofs.use-cases.spec.ts y payment-proofs.e2e-spec.ts',
  // DX-359: personal y accesos. Cada repositorio escribe el evento en la
  // MISMA transacción que el cambio (writeAuditEvent); ninguno guarda el
  // token, su hash, el email ni el nombre.
  // Invitar: CREATE STAFF_INVITATION con el rol (la pendiente que sustituye,
  // VOID INVITATION_REPLACED); reenviar: UPDATE INVITATION_RESENT; retirar:
  // VOID INVITATION_REVOKED (PENDING → REVOKED).
  'POST /staff/invitations':
    'invitation-audit.spec.ts, create-invitation.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  'POST /staff/invitations/:id/resend':
    'invitation-audit.spec.ts, resend-invitation.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  'DELETE /staff/invitations/:id':
    'invitation-audit.spec.ts, revoke-invitation.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  // Aceptar (cuenta nueva, existente o reclamada): CREATE STAFF_MEMBER
  // INVITATION_ACCEPTED con rol y sedes; el reclamo deja además su
  // PASSWORD_RESET INVITATION_ACCOUNT_CLAIM (DX-029).
  'POST /public/invitations/:token/accept':
    'accept-invitation.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  // UPDATE STAFF_MEMBER STAFF_UPDATED con el antes y el después de rol,
  // sedes, registro profesional y especialidad (el nombre, solo en
  // changedFields); sin evento si nada cambió.
  'PATCH /staff/:userId':
    'staff-audit.spec.ts, update-staff.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  // DX-089 / DX-381: UPDATE STAFF_MEMBER LOCATIONS_CHANGED con las sedes
  // antes y después (null = todas); sin evento si el conjunto no cambia.
  'PUT /staff/:userId/locations':
    'staff-audit.spec.ts, staff-locations.use-cases.spec.ts y staff-access-audit.e2e-spec.ts',
  // DX-090: UPDATE STAFF_MEMBER PERMISSIONS_CHANGED con los permisos extra
  // antes y después; sin evento si el conjunto no cambia.
  'PUT /staff/:userId/permissions':
    'staff-audit.spec.ts, staff-permissions.use-cases.spec.ts y staff-permissions.e2e-spec.ts',
  // STAFF_REACTIVATED / STAFF_DEACTIVATED con el estado antes y después.
  'POST /staff/:userId/reactivate':
    'staff-audit.spec.ts y staff-access-audit.e2e-spec.ts',
  'DELETE /staff/:userId':
    'staff-audit.spec.ts y staff-access-audit.e2e-spec.ts',
  // DX-359: cuenta. CREATE CLINIC CLINIC_REGISTERED (el dueño, ADMIN) en la
  // transacción del alta; PATCH /me: UPDATE STAFF_MEMBER OWN_NAME_CHANGED
  // (sin el nombre); contraseña: PASSWORD_CHANGE SESSIONS_REVOKED, solo el
  // hecho (en platform_audit_events con sesión de plataforma).
  'POST /auth/register/verify':
    'registration-audit.spec.ts y staff-access-audit.e2e-spec.ts',
  'PATCH /me':
    'update-my-name.use-case.spec.ts y staff-access-audit.e2e-spec.ts',
  'POST /me/password':
    'change-my-password.use-case.spec.ts, me-profile-repo.int-spec.ts y staff-access-audit.e2e-spec.ts',
  // DX-359: plataforma. MFA_ENROLLMENT_STARTED y MFA_ENABLED en
  // `platform_audit_events`, sin secreto, código ni URI.
  // DX-021: verificación en dos pasos de los miembros, en la auditoría de la
  // clínica, sin secreto, URI ni códigos (TOTP o de recuperación).
  'POST /auth/login/mfa':
    'complete-mfa-login.use-case (LOGIN MFA_TOTP / MFA_RECOVERY_CODE, LOGIN_FAILED INVALID_MFA_CODE) y user-mfa.e2e-spec.ts',
  'POST /auth/login/mfa/enrollment':
    'user-mfa.service (UPDATE STAFF_MEMBER MFA_ENROLLMENT_STARTED), complete-mfa-login.use-case.spec.ts (LOGIN_FAILED INVALID_EMAIL_CODE, SEC-066) y user-mfa.e2e-spec.ts',
  'POST /auth/login/mfa/enrollment/confirm':
    'user-mfa.service (MFA_ENABLED, misma transacción) + LOGIN MFA_ENROLLED; user-mfa.e2e-spec.ts',
  'POST /me/mfa/enrollment':
    'user-mfa.service (MFA_ENROLLMENT_STARTED) y user-mfa.e2e-spec.ts',
  'POST /me/mfa/enrollment/confirm':
    'user-mfa.service.spec.ts (MFA_ENABLED, misma transacción) y user-mfa.e2e-spec.ts',
  'POST /me/mfa/disable':
    'user-mfa.service.spec.ts (MFA_DISABLED, misma transacción) y user-mfa.e2e-spec.ts',
  'POST /me/mfa/recovery-codes':
    'user-mfa.service.spec.ts (MFA_RECOVERY_CODES_REGENERATED) y user-mfa.e2e-spec.ts',
  'PUT /security-policy':
    'user-mfa.service.spec.ts (CLINIC_SETTINGS MFA_POLICY con antes/después) y user-mfa.e2e-spec.ts',
  // DX-021-bis: los códigos del superadmin van a `platform_audit_events`.
  'POST /platform/mfa/recovery-codes':
    'user-mfa.service (MFA_RECOVERY_CODES_REGENERATED) y mfa-bis.e2e-spec.ts',
  'DELETE /me/mfa/trusted-devices':
    'user-mfa.service (MFA_TRUSTED_DEVICES_REVOKED) y mfa-bis.e2e-spec.ts',
  'DELETE /me/mfa/trusted-devices/:id':
    'user-mfa.service (MFA_TRUSTED_DEVICES_REVOKED) y mfa-bis.e2e-spec.ts',
  // DX-137: DELETE SESSION en la transacción que cierra (con `reason` y
  // `sessionsClosed`, IP truncada y navegador resumido); sin evento si no
  // cerró ninguna. «No fui yo»: SESSION_NOT_ME con el titular como actor.
  'DELETE /me/sessions/:sessionId':
    'user-sessions.service (SESSION_REVOKED_BY_SELF) y user-sessions.e2e-spec.ts',
  'POST /me/sessions/revoke-others':
    'user-sessions.service (OTHER_SESSIONS_REVOKED) y user-sessions.e2e-spec.ts',
  'DELETE /staff/:userId/sessions/:sessionId':
    'user-sessions.service (SESSION_REVOKED_BY_ADMIN) y user-sessions.e2e-spec.ts',
  'POST /staff/:userId/sessions/revoke-all':
    'user-sessions.service (MEMBER_SESSIONS_REVOKED_BY_ADMIN) y user-sessions.e2e-spec.ts',
  'POST /auth/session-alerts/not-me':
    'user-sessions.service (SESSION_NOT_ME, en la transacción que cierra todo) y user-sessions.e2e-spec.ts',
  'POST /staff/:userId/mfa/reset':
    'user-mfa.service (MFA_RESET_<motivo> / MFA_RESET_REFUSED, en la transacción del reseteo) y mfa-bis.e2e-spec.ts',
  // DX-439: CREATE CLOSING_QUEUE_DISMISSAL (CLOSING_QUEUE_DISMISSED) en la
  // transacción del descarte, con la sección y el código del motivo y la cita
  // (y el ítem) en `params`; nunca el texto de «Otro».
  'POST /closing-queue/dismissals':
    'closing-queue.use-cases.spec.ts y closing-queue.e2e-spec.ts',
  // DX-360: configuración de la clínica, en la transacción del cambio
  // (`configChange` con el antes/después de los campos cambiados; sin evento
  // si una edición no cambia nada). Texto libre y secretos nunca.
  // Sedes: CREATE LOCATION; horario: UPDATE LOCATION_SCHEDULE con
  // `scheduleChange`; recordatorios: UPDATE REMINDER_SETTINGS, en su sede.
  'POST /locations': 'config-audit.e2e-spec.ts',
  'PUT /locations/schedule':
    'location-schedule-audit.spec.ts y config-audit.e2e-spec.ts',
  'PUT /reminder-settings/:locationId': 'config-audit.e2e-spec.ts',
  // Dominio: CREATE TENANT_DOMAIN sin el token; política: CREATE
  // PRIVACY_POLICY con versión y hash, sin los textos.
  'POST /domains': 'config-audit.e2e-spec.ts',
  'POST /privacy-policies':
    'privacy-policy-audit.spec.ts y config-audit.e2e-spec.ts',
  // Catálogos: APPOINTMENT_TYPE y PAYER (CREATE/UPDATE/DELETE).
  'POST /appointment-types': 'config-audit.e2e-spec.ts',
  'PATCH /appointment-types/:id': 'config-audit.e2e-spec.ts',
  'DELETE /appointment-types/:id': 'config-audit.e2e-spec.ts',
  // DX-015-bis: tipos de recall (RECALL_TYPE): alta, edición con el diff,
  // retirada y disparadores con los ids de antes y de después.
  'POST /recall-types': 'recall-types.e2e-spec.ts',
  'PATCH /recall-types/:id': 'recall-types.e2e-spec.ts',
  'DELETE /recall-types/:id': 'recall-types.e2e-spec.ts',
  'PUT /recall-types/:id/triggers': 'recall-types.e2e-spec.ts',
  // DX-015-bis (D15): «Programar recall». UPDATE PATIENT_RECALL (como el PUT)
  // con `via: 'DEFAULT'` y el recall en `resourceId`, y los de la exclusión,
  // en la transacción del alta.
  'POST /patients/:id/recalls/default':
    'recall-default.int-spec.ts y recall.e2e-spec.ts',
  // DX-465: el lote de intentos (un CREATE RECALL_CONTACT por contacto, con
  // su paciente y sin la nota, reason RECALL_CONTACT_BATCH), los ajustes de
  // intentos por sede (UPDATE CLINIC_SETTINGS, RECALL_SETTINGS_UPDATED, antes
  // y después; sin evento si nada cambia) y «Ya está corregido» (UPDATE
  // PATIENT, PHONE_REVIEW_CLEARED, solo si había marca), en la transacción.
  'POST /recall/contacts/batch':
    'recall-attempts.int-spec.ts y recall-attempts.e2e-spec.ts',
  'PUT /recall-settings/:locationId': 'recall-attempts.e2e-spec.ts',
  'POST /patients/:id/phone-review/clear':
    'recall-attempts.int-spec.ts y recall-attempts.e2e-spec.ts',
  // DX-516: ajustes por medio de pago (solo ADMIN): UPDATE/CREATE
  // PAYMENT_METHOD con PAYMENT_METHOD_ADJUSTMENT_CREATED/UPDATED y el antes y
  // el después, en la transacción del cambio.
  'POST /payment-methods/:id/adjustments':
    'payment-method-adjustments.e2e-spec.ts',
  'PATCH /payment-methods/:id/adjustments/:adjustmentId':
    'payment-method-adjustments.e2e-spec.ts',
  'POST /payers': 'config-audit.e2e-spec.ts',
  'PATCH /payers/:id': 'config-audit.e2e-spec.ts',
  // DX-559: plantillas de plan (TREATMENT_PLAN_TEMPLATE con
  // PLAN_TEMPLATE_CREATED/UPDATED; líneas e intervalos solo por nombre de
  // campo). Aplicarla: UPDATE TREATMENT_PLAN PLAN_TEMPLATE_APPLIED con
  // `params.templateId` y `params.itemsCreated`, en la transacción del alta.
  // DX-572: plantillas de órdenes externas (EXTERNAL_ORDER_TEMPLATE con
  // EXTERNAL_ORDER_TEMPLATE_CREATED/UPDATED; el destinatario y los estudios
  // solo por nombre de campo), el plazo para «vencida» (CLINIC_SETTINGS
  // EXTERNAL_ORDER_SETTINGS) y la descarga pública de la copia (EXPORT
  // EXTERNAL_ORDER sin usuario, EXTERNAL_ORDER_COPY_DOWNLOADED, en la
  // transacción que gasta el enlace).
  'POST /external-order-templates': 'external-orders.e2e-spec.ts',
  'PATCH /external-order-templates/:id': 'external-orders.e2e-spec.ts',
  'PUT /external-orders/settings':
    'external-orders.use-cases.spec.ts y external-orders.e2e-spec.ts',
  'POST /public/external-order-copies/:token/download':
    'external-order-copies.int-spec.ts y external-order-copies.e2e-spec.ts',
  'POST /treatment-plan-templates': 'config-audit.e2e-spec.ts',
  'PATCH /treatment-plan-templates/:id': 'config-audit.e2e-spec.ts',
  'POST /treatment-plans/:id/apply-template':
    'apply-plan-template.use-case.spec.ts y treatment-plan-templates.e2e-spec.ts',
  'DELETE /payers/:id': 'config-audit.e2e-spec.ts',
  // Plantillas: CONSENT_TEMPLATE (el texto solo por nombre, con la versión)
  // y PRESCRIPTION_TEMPLATE (nombre y nº de medicamentos).
  'POST /consent-templates': 'config-audit.e2e-spec.ts',
  'PATCH /consent-templates/:id': 'config-audit.e2e-spec.ts',
  'POST /prescription-templates': 'config-audit.e2e-spec.ts',
  'PATCH /prescription-templates/:id': 'config-audit.e2e-spec.ts',
  'DELETE /prescription-templates/:id': 'config-audit.e2e-spec.ts',
  // Inventario: INVENTORY_ITEM en la sede del artículo e INVENTORY_MOVEMENT
  // en la sede del movimiento, sin notas ni motivo.
  'POST /inventory/items': 'config-audit.e2e-spec.ts',
  'PATCH /inventory/items/:id': 'config-audit.e2e-spec.ts',
  'DELETE /inventory/items/:id': 'config-audit.e2e-spec.ts',
  'POST /inventory/items/:id/movements': 'config-audit.e2e-spec.ts',
};

/**
 * Rutas que escriben (POST/PUT/PATCH/DELETE) SIN evento de auditoría, cada una
 * con su motivo. No es una lista de «ya está bien»: las marcadas «hueco» son
 * cambios que deberían quedar auditados y tienen ticket pendiente; el resto
 * no escriben datos de la clínica o no escriben nada.
 */
const KNOWN_UNAUDITED: Record<string, string> = {
  // --- No escriben nada o solo preparan una escritura auditada ------------
  'POST /auth/reset-password/check':
    'solo comprueba el token (POST por el cuerpo)',
  'POST /locations/:id/holidays/import/preview':
    'vista previa de la importación; no escribe',
  // DX-562: las vistas previas de la serie (crear y mover) solo calculan.
  'POST /message-templates/:key/:channel/:language/preview':
    'DX-565: solo renderiza el borrador con datos de ejemplo (POST por el cuerpo); no guarda ni envía nada',
  'POST /appointments/series/preview':
    'vista previa de la serie de citas; no escribe',
  'POST /appointments/series/:id/move/preview':
    'vista previa de mover las citas de la serie; no escribe',
  'POST /patient-imports/inspect': 'no escribe nada ni crea lote',
  // DX-571: inspección y vista previa del extracto no escriben (como
  // `inspect` de DX-107).
  'POST /bank-reconciliation/accounts/:id/statements/inspect':
    'no escribe nada',
  'POST /bank-reconciliation/accounts/:id/statements/preview':
    'no escribe nada',
  // DX-205: la vista previa de «Actualizar precios» del catálogo solo calcula.
  'POST /catalog/price-changes/preview':
    'vista previa de la subida de precios del catálogo; no escribe',
  // DX-559: la vista previa de una plantilla solo calcula precios y visitas.
  'POST /treatment-plans/:id/apply-template/preview':
    'vista previa de la plantilla; no escribe',
  'POST /patients/:patientId/documents/upload-url':
    'URL prefirmada; el alta del documento es la ruta auditada',
  'POST /expenses/attachments/upload-url':
    'URL prefirmada; el gasto que la usa es la ruta auditada',
  'POST /payments/proofs/upload-url':
    'URL prefirmada; el abono que la usa es la ruta auditada',
  'POST /files/uploads':
    'subida directa del adaptador de disco (desarrollo y tests)',
  'PATCH /patients/:patientId/clinical-entries/:entryId':
    'siempre rechaza: una evolución firmada no se edita',
  'PUT /patients/:patientId/clinical-entries/:entryId':
    'siempre rechaza: una evolución firmada no se edita',
  'DELETE /patients/:patientId/clinical-entries/:entryId':
    'siempre rechaza: una evolución firmada no se borra',
  'PATCH /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
    'siempre rechaza: la anestesia registrada no se edita (DX-307)',
  'PUT /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
    'siempre rechaza: la anestesia registrada no se edita (DX-307)',
  'DELETE /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
    'siempre rechaza: la anestesia registrada no se borra (DX-307)',
  'PATCH /patients/:patientId/clinical-entries/:entryId/sedation':
    'siempre rechaza: la hoja de sedación no se edita (DX-407)',
  'PUT /patients/:patientId/clinical-entries/:entryId/sedation':
    'siempre rechaza: la hoja de sedación no se edita (DX-407)',
  'DELETE /patients/:patientId/clinical-entries/:entryId/sedation':
    'siempre rechaza: la hoja de sedación no se borra (DX-407)',

  // --- Sesión y cuenta propia ---------------------------------------------
  'POST /auth/register': 'pide el enlace de verificación; aún no hay clínica',
  'POST /auth/refresh': 'rota el token de refresco',
  'POST /auth/logout': 'revoca el token de refresco',
  'POST /auth/forgot-password': 'envía el email; no enumera cuentas',
  'POST /me/avatar': 'foto de perfil propia',
  'DELETE /me/avatar': 'foto de perfil propia',
  // DX-020: solo esconde la ayuda del panel; no cambia ningún ajuste.
  'POST /onboarding/dismiss':
    'descarta la tarjeta «Pon en marcha tu clínica»; sin evento',

  // --- Citas y enlaces al paciente -----------------------------------------
  'POST /public/post-op-instructions/:token/opened':
    'marca la apertura de la indicación; sin evento',
  // DX-424: igual para la anamnesis por enlace (`openedAt` del envío).
  'POST /public/medical-history/:token/opened':
    'marca la apertura del cuestionario; sin evento',
  // DX-101: salir del portal del paciente solo borra la cookie.
  'POST /public/patient-access/me/logout':
    'borra la cookie de la sesión del portal; sin evento',
  // DX-569: el enlace de pago.
  'POST /public/payment-links/:token/opened':
    'marca la apertura del enlace de pago; sin evento',
  // DX-464: el enlace de conformidad del profesional.
  'POST /public/commission-receipts/:token/opened':
    'marca la apertura del enlace de conformidad; sin evento',
  'POST /public/payment-links/:token/proof-upload':
    'URL prefirmada; el reporte que la usa es la ruta auditada',
  'POST /public/payment-links/:token/proof-upload/complete':
    'prepara el comprobante; el reporte que lo usa es la ruta auditada',
};

const CONTROLLERS: Type[] = [
  AcquisitionController,
  PatientSourcesController,
  PatientAcquisitionController,
  LeadsController,
  LeadReasonsController,
  CommissionsController,
  CommissionPaymentsController,
  AuthController,
  PatientCertificatesController,
  PatientExternalOrdersController,
  ExternalOrdersController,
  ClinicalRecordCopiesController,
  PatientsController,
  CallerLookupController,
  PatientAnamnesisRequestsController,
  PatientSignatureRequestsController,
  MedicalHistorySubmissionsController,
  PatientResponsiblePartiesController,
  PatientMajorityReviewController,
  PatientCoveragesController,
  PatientAgreementsController,
  MedicalHistoryController,
  ClinicalEntriesController,
  ClinicalEntrySettingsController,
  AnesthesiaController,
  AnestheticsController,
  SedationController,
  DentalCatalogController,
  CatalogPriceChangesController,
  PriceListsController,
  AgreementsController,
  LocationsController,
  LocationCalendarController,
  OdontogramController,
  PerioExamsController,
  PatientConsentsController,
  PatientDataConsentsController,
  PatientPrescriptionsController,
  PrescriptionsController,
  PatientImplantsController,
  ImplantsController,
  PatientOrthoController,
  OrthoController,
  PatientLabOrdersController,
  LabOrdersController,
  PatientDocumentsController,
  PatientImportsController,
  BankReconciliationController,
  PlanVisitsController,
  AppointmentsController,
  PlanFollowUpController,
  QuoteFollowUpPauseController,
  TreatmentPlansController,
  PlanQuoteController,
  PriceQuoteController,
  QuoteSettingsController,
  SlotOfferSettingsController,
  PlanRepricingController,
  PaymentsController,
  PaymentReceiptsController,
  PaymentReceiptSummaryController,
  ReceiptSettingsController,
  PaymentAllocationsController,
  PaymentPlansController,
  InstallmentSimulationController,
  AccountStatementController,
  ReceivablesController,
  DiscountPolicyController,
  PatientCreditController,
  CancellationPolicyController,
  CancellationFeeController,
  DiscountReportController,
  ProductionByProcedureController,
  QuoteFunnelController,
  ScheduledProductionController,
  UnallocatedPaymentsController,
  RecoveredSlotsController,
  ChairOccupancyController,
  ClosingQueueController,
  PostOpChecksController,
  ContingencyAgendaController,
  CollectionsController,
  RecallController,
  PatientRecallsController,
  CashSessionsController,
  ExpenseReportsController,
  ExpensesController,
  ExpenseCategoriesController,
  CashOutflowsController,
  ScheduleBlocksController,
  ChairsController,
  EquipmentController,
  StaffController,
  ClinicalNoteTemplatesController,
  // DX-559: sin @Audit; sus escrituras se auditan en la transacción.
  TreatmentPlanTemplatesController,
  PlanTemplateApplyController,
  DomainsController,
  PostOpTemplatesController,
  AppointmentPostOpController,
  PatientPostOpDeliveriesController,
  // DX-569: el enlace de pago del paciente.
  PatientPaymentLinksController,
  PatientAccessLinksController,
  ProviderScheduleController,
  ScheduleRosterController,
  ExchangeSettingsController,
  PaymentMethodsController,
];

function joinPath(...parts: string[]): string {
  const path = parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');
  return `/${path}`;
}

interface AuditedRoute {
  key: string;
  options: AuditOptions;
  handlerInterceptors: unknown[];
  classInterceptors: unknown[];
}

function auditedRoutes(controller: Type): AuditedRoute[] {
  const base = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
  const classInterceptors =
    (Reflect.getMetadata(INTERCEPTORS_METADATA, controller) as unknown[]) ?? [];
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (typeof handler !== 'function' || name === 'constructor') return [];
    const options = Reflect.getMetadata(AUDIT_OPTIONS, handler) as
      AuditOptions | undefined;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as
      string | undefined;
    if (!options || path === undefined) return [];
    const method =
      RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
      ];
    return [
      {
        key: `${method} ${joinPath(base, path)}`,
        options,
        handlerInterceptors:
          (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[]) ??
          [],
        classInterceptors,
      },
    ];
  });
}

describe('cobertura de la auditoría (DX-009)', () => {
  const routes = CONTROLLERS.flatMap(auditedRoutes);

  it('cada endpoint clínico y financiero lleva su @Audit, con la acción y el recurso esperados', () => {
    expect(Object.fromEntries(routes.map((r) => [r.key, r.options]))).toEqual(
      EXPECTED,
    );
  });

  // Todas las rutas de la app, no solo las de CONTROLLERS.
  const appRoutes = discoverRoutes(collectControllers(AppModule));
  const isDecorated = (route: (typeof appRoutes)[number]) =>
    Reflect.getMetadata(
      AUDIT_OPTIONS,
      (route.controllerClass.prototype as Record<string, object>)[
        route.handler
      ],
    ) !== undefined;
  const mutating = appRoutes.filter((r) =>
    /^(POST|PUT|PATCH|DELETE) /.test(r.key),
  );

  it('las rutas auditadas en el caso de uso existen y no llevan además @Audit', () => {
    const all = new Set(appRoutes.map((r) => r.key));
    const decorated = new Set(appRoutes.filter(isDecorated).map((r) => r.key));
    expect(
      Object.keys(AUDITED_IN_USE_CASE).filter(
        (key) => !all.has(key) || decorated.has(key),
      ),
    ).toEqual([]);
  });

  it('cada ruta que escribe está auditada (@Audit en EXPECTED o en su caso de uso) o es una excepción con nombre', () => {
    expect(
      mutating
        .map((r) => r.key)
        .filter(
          (key) =>
            !(key in EXPECTED) &&
            !(key in AUDITED_IN_USE_CASE) &&
            !(key in KNOWN_UNAUDITED),
        ),
    ).toEqual([]);
  });

  it('KNOWN_UNAUDITED solo nombra rutas que escriben, existen y no tienen auditoría', () => {
    const keys = new Set(mutating.map((r) => r.key));
    const decorated = new Set(mutating.filter(isDecorated).map((r) => r.key));
    expect(
      Object.keys(KNOWN_UNAUDITED).filter(
        (key) =>
          !keys.has(key) ||
          decorated.has(key) ||
          key in EXPECTED ||
          key in AUDITED_IN_USE_CASE,
      ),
    ).toEqual([]);
  });

  it('el AuditInterceptor va en el MÉTODO: corre dentro del contexto de tenant de la clase', () => {
    for (const route of routes) {
      expect({
        route: route.key,
        ok: route.handlerInterceptors.includes(AuditInterceptor),
      }).toEqual({
        route: route.key,
        ok: true,
      });
      if (route.key !== 'POST /auth/login') {
        expect({
          route: route.key,
          tenant: route.classInterceptors.includes(TenantContextInterceptor),
        }).toEqual({ route: route.key, tenant: true });
      }
    }
  });
});
