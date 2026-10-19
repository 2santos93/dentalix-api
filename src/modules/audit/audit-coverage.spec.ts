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
import { PatientResponsiblePartiesController } from '../patients/presentation/patient-responsible-parties.controller';
import { MedicalHistoryController } from '../medical-history/presentation/medical-history.controller';
import { ClinicalEntriesController } from '../clinical-entries/presentation/clinical-entries.controller';
import { ClinicalEntryRdaController } from '../clinical-entries/presentation/clinical-entry-rda.controller';
import { DentalCatalogController } from '../dental-catalog/presentation/dental-catalog.controller';
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
import { PlanFollowUpController } from '../treatment-plans/presentation/plan-follow-up.controller';
import { PaymentsController } from '../payments/presentation/payments.controller';
import { PaymentReceiptsController } from '../payments/presentation/payment-receipts.controller';
import { PaymentPlansController } from '../payment-plans/presentation/payment-plans.controller';
import { AccountStatementController } from '../account-statement/presentation/account-statement.controller';
import { ReceivablesController } from '../receivables/presentation/receivables.controller';
import { DiscountPolicyController } from '../discounts/presentation/discount-policy.controller';
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

/**
 * Qué endpoints quedan auditados y cómo (DX-009). Tabla escrita a mano: un
 * `@Audit` que desaparece, cambia de acción o de recurso, o una ruta nueva
 * auditada sin entrada, ponen `npm test` en rojo.
 *
 * Fuera a propósito: `GET /patients` (búsqueda, no es la ficha de nadie) y
 * `GET /audit-events` (leer el propio registro).
 */
const P = { param: 'patientId' } as const;
const RES = { response: 'id' } as const;
const plan = (param = 'id') => ({ lookup: 'treatmentPlan', param }) as const;

const EXPECTED: Record<string, AuditOptions> = {
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
  // DX-212: datos del RDA de una atención, y los códigos CUPS y REPS.
  'GET /clinical-entries/:id/rda-readiness': {
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY',
    resourceId: { param: 'id' },
    patient: { lookup: 'clinicalEntry', param: 'id' },
    reason: 'RDA_READINESS',
  },
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

const CONTROLLERS: Type[] = [
  AuthController,
  PatientsController,
  PatientResponsiblePartiesController,
  MedicalHistoryController,
  ClinicalEntriesController,
  ClinicalEntryRdaController,
  DentalCatalogController,
  LocationsController,
  OdontogramController,
  PerioExamsController,
  PatientConsentsController,
  PatientDataConsentsController,
  PatientPrescriptionsController,
  PrescriptionsController,
  PatientImplantsController,
  ImplantsController,
  PlanFollowUpController,
  TreatmentPlansController,
  PlanQuoteController,
  PaymentsController,
  PaymentReceiptsController,
  PaymentPlansController,
  AccountStatementController,
  ReceivablesController,
  DiscountPolicyController,
  DiscountReportController,
  CollectionsController,
  CashSessionsController,
  ScheduleBlocksController,
  StaffController,
  ClinicalNoteTemplatesController,
  DomainsController,
  PostOpTemplatesController,
  AppointmentPostOpController,
  PatientPostOpDeliveriesController,
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
