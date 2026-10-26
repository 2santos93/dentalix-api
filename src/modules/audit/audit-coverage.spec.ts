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
import { PatientsController } from '../patients/presentation/patients.controller';
import { PatientAgreementsController } from '../patient-agreements/presentation/patient-agreements.controller';
import { PatientCoveragesController } from '../patient-coverages/presentation/patient-coverages.controller';
import { PatientResponsiblePartiesController } from '../patients/presentation/patient-responsible-parties.controller';
import { MedicalHistoryController } from '../medical-history/presentation/medical-history.controller';
import { PatientAnamnesisRequestsController } from '../medical-history-submissions/presentation/patient-anamnesis-requests.controller';
import { MedicalHistorySubmissionsController } from '../medical-history-submissions/presentation/medical-history-submissions.controller';
import { ClinicalEntriesController } from '../clinical-entries/presentation/clinical-entries.controller';
import { DentalCatalogController } from '../dental-catalog/presentation/dental-catalog.controller';
import { PriceListsController } from '../price-lists/presentation/price-lists.controller';
import { AgreementsController } from '../agreements/presentation/agreements.controller';
import { LocationsController } from '../locations/presentation/locations.controller';
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
import { PlanFollowUpController } from '../treatment-plans/presentation/plan-follow-up.controller';
import { PaymentsController } from '../payments/presentation/payments.controller';
import { PaymentReceiptsController } from '../payments/presentation/payment-receipts.controller';
import { PaymentAllocationsController } from '../payments/presentation/payment-allocations.controller';
import { PaymentPlansController } from '../payment-plans/presentation/payment-plans.controller';
import { AccountStatementController } from '../account-statement/presentation/account-statement.controller';
import { ReceivablesController } from '../receivables/presentation/receivables.controller';
import { DiscountPolicyController } from '../discounts/presentation/discount-policy.controller';
import { CancellationPolicyController } from '../cancellation-policies/presentation/cancellation-policy.controller';
import { CancellationFeeController } from '../cancellation-fees/presentation/cancellation-fee.controller';
import { DiscountReportController } from '../discounts/presentation/discount-report.controller';
import { CollectionsController } from '../collections/presentation/collections.controller';
import { CashSessionsController } from '../cash-sessions/presentation/cash-sessions.controller';
import { ScheduleBlocksController } from '../schedule-blocks/presentation/schedule-blocks.controller';
import { StaffController } from '../staff/presentation/staff.controller';
import { ClinicalNoteTemplatesController } from '../clinical-note-templates/presentation/clinical-note-templates.controller';
import { DomainsController } from '../domains/presentation/domains.controller';
import { PostOpTemplatesController } from '../post-op-instructions/presentation/post-op-templates.controller';
import { AppointmentPostOpController } from '../post-op-instructions/presentation/appointment-post-op.controller';
import { PatientPostOpDeliveriesController } from '../post-op-instructions/presentation/patient-post-op-deliveries.controller';
import {
  ImplantsController,
  PatientImplantsController,
} from '../implants/presentation/implants.controller';
import { PatientDocumentsController } from '../patient-documents/presentation/patient-documents.controller';
import { ExpenseCategoriesController } from '../expenses/presentation/expense-categories.controller';
import { ExpenseReportsController } from '../expenses/presentation/expense-reports.controller';
import { ExpensesController } from '../expenses/presentation/expenses.controller';
import { CashOutflowsController } from '../expenses/presentation/cash-outflows.controller';
import { PatientImportsController } from '../patient-imports/presentation/patient-imports.controller';
import {
  ProviderScheduleController,
  ScheduleRosterController,
} from '../provider-schedule/presentation/provider-schedule.controller';

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
  // DX-203: responsables de pago y avisos, con el motivo y los nombres de los
  // campos (nunca los datos del tercero).
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
  // DX-039: archivar y retención legal de la HC.
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
  // DX-262: abono contra el saldo migrado (con su recibo de caja).
  'POST /opening-balances/:id/payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: { lookup: 'openingBalance', param: 'id' },
    reason: 'RECEIPT_ISSUED',
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
  'POST /patients/:patientId/treatment-plans/:planId/acceptance': {
    action: 'SIGN',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: P,
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

  'GET /payments': { action: 'VIEW', resource: 'PAYMENT' },
  // DX-136: el recibo numerado se emite en la misma transacción que el abono.
  'POST /treatment-plans/:id/payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: plan(),
    reason: 'RECEIPT_ISSUED',
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
  'PUT /payments/:id/allocations': {
    action: 'UPDATE',
    resource: 'PAYMENT_ALLOCATION',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
    reason: 'PAYMENT_REALLOCATED',
    allocation: true,
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
  'DELETE /treatment-plans/:id/payment-plan': {
    action: 'DELETE',
    resource: 'PAYMENT_PLAN',
    patient: plan(),
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
  // DX-204: política de descuentos (solo ADMIN) e informe de descuentos (lista
  // de muchos pacientes, sin paciente en el evento) y su CSV.
  'PUT /discount-policy': { action: 'UPDATE', resource: 'DISCOUNT_POLICY' },
  // DX-279: nueva versión de la política de cancelación de una sede.
  'POST /locations/:id/cancellation-policy': {
    action: 'CREATE',
    resource: 'CANCELLATION_POLICY',
    resourceId: RES,
    reason: 'CANCELLATION_POLICY_CHANGED',
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
  // DX-150: cobranza. La nota se audita sin su texto (solo los nombres de los
  // campos); el cambio de estado del compromiso lo audita SettlePaymentPromises.
  'POST /patients/:id/collection-notes': {
    action: 'CREATE',
    resource: 'COLLECTION_NOTE',
    resourceId: RES,
    patient: { param: 'id' },
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

  // DX-048: un ADMIN desbloquea el inicio de sesión de un miembro.
  'POST /staff/:userId/login-unlock': {
    action: 'UPDATE',
    resource: 'STAFF_MEMBER',
    resourceId: { param: 'userId' },
    reason: 'LOGIN_UNLOCKED',
  },

  // DX-089: un ADMIN cambia las sedes en las que puede trabajar un miembro.
  'PUT /staff/:userId/locations': {
    action: 'UPDATE',
    resource: 'STAFF_MEMBER',
    resourceId: { param: 'userId' },
    reason: 'LOCATIONS_CHANGED',
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
  // DX-274: VIEW si se abre en el navegador, EXPORT si se descarga (la acción
  // depende de la query, que el decorador no lee).
  'GET /expenses/:id/attachment/url':
    'expense-receipts.use-cases.spec.ts y expenses.e2e-spec.ts',
};

const CONTROLLERS: Type[] = [
  AuthController,
  PatientsController,
  PatientAnamnesisRequestsController,
  MedicalHistorySubmissionsController,
  PatientResponsiblePartiesController,
  PatientCoveragesController,
  PatientAgreementsController,
  MedicalHistoryController,
  ClinicalEntriesController,
  DentalCatalogController,
  PriceListsController,
  AgreementsController,
  LocationsController,
  OdontogramController,
  PerioExamsController,
  PatientConsentsController,
  PatientDataConsentsController,
  PatientPrescriptionsController,
  PrescriptionsController,
  PatientImplantsController,
  ImplantsController,
  PatientDocumentsController,
  PatientImportsController,
  PlanVisitsController,
  AppointmentsController,
  PlanFollowUpController,
  TreatmentPlansController,
  PlanQuoteController,
  PriceQuoteController,
  PaymentsController,
  PaymentReceiptsController,
  PaymentAllocationsController,
  PaymentPlansController,
  AccountStatementController,
  ReceivablesController,
  DiscountPolicyController,
  CancellationPolicyController,
  CancellationFeeController,
  DiscountReportController,
  CollectionsController,
  CashSessionsController,
  ExpenseReportsController,
  ExpensesController,
  ExpenseCategoriesController,
  CashOutflowsController,
  ScheduleBlocksController,
  StaffController,
  ClinicalNoteTemplatesController,
  DomainsController,
  PostOpTemplatesController,
  AppointmentPostOpController,
  PatientPostOpDeliveriesController,
  ProviderScheduleController,
  ScheduleRosterController,
];

function joinPath(...parts: string[]): string {
  const path = parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');
  return `/${path}`;
}

/** `MÉTODO /ruta` de todos los handlers del controlador, auditados o no. */
function routeKeys(controller: Type): string[] {
  const base = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (typeof handler !== 'function' || name === 'constructor') return [];
    const path = Reflect.getMetadata(PATH_METADATA, handler) as
      string | undefined;
    if (path === undefined) return [];
    const method =
      RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
      ];
    return [`${method} ${joinPath(base, path)}`];
  });
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

  it('las rutas auditadas en el caso de uso existen y no llevan además @Audit', () => {
    const all = new Set(CONTROLLERS.flatMap(routeKeys));
    const decorated = new Set(routes.map((r) => r.key));
    expect(
      Object.keys(AUDITED_IN_USE_CASE).filter(
        (key) => !all.has(key) || decorated.has(key),
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
