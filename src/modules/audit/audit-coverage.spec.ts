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
import { MedicalHistoryController } from '../medical-history/presentation/medical-history.controller';
import { ClinicalEntriesController } from '../clinical-entries/presentation/clinical-entries.controller';
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
import { PaymentPlansController } from '../payment-plans/presentation/payment-plans.controller';
import { AccountStatementController } from '../account-statement/presentation/account-statement.controller';

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
  'GET /patients/:patientId/clinical-entries': {
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY',
    patient: P,
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
  'POST /treatment-plans/:id/payments': {
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: RES,
    patient: plan(),
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
  'GET /patients/:patientId/billable-plans': {
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    patient: P,
  },
};

const CONTROLLERS: Type[] = [
  AuthController,
  PatientsController,
  MedicalHistoryController,
  ClinicalEntriesController,
  OdontogramController,
  PerioExamsController,
  PatientConsentsController,
  PatientDataConsentsController,
  PatientPrescriptionsController,
  PrescriptionsController,
  PlanFollowUpController,
  TreatmentPlansController,
  PlanQuoteController,
  PaymentsController,
  PaymentPlansController,
  AccountStatementController,
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
