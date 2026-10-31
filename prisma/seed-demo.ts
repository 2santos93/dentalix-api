import {
  ConflictException,
  INestApplicationContext,
  Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentStatus,
  ClinicRole,
  PaymentMethod,
  Prisma,
  ScheduleBlockKind,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
  WaitlistPriority,
} from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { AUTH_REPOSITORY } from '../src/modules/auth/domain/ports/auth-repository.port';
import type { AuthRepository } from '../src/modules/auth/domain/ports/auth-repository.port';
import { PasswordService } from '../src/shared/crypto/password.service';
import { CreateInvitationUseCase } from '../src/modules/invitations/application/use-cases/create-invitation.use-case';
import { AcceptInvitationUseCase } from '../src/modules/invitations/application/use-cases/accept-invitation.use-case';
import {
  CreateLocationUseCase,
  UpdateLocationUseCase,
} from '../src/modules/locations/application/use-cases/manage-locations.use-cases';
import {
  GetLocationScheduleUseCase,
  ReplaceLocationScheduleUseCase,
} from '../src/modules/location-schedule/application/use-cases/manage-location-schedule.use-cases';
import {
  BusinessHours,
  fitsBusinessHours,
} from '../src/modules/location-schedule/application/business-hours';
import {
  CreatePriceListUseCase,
  ListPriceListsUseCase,
  ReplacePriceListItemsUseCase,
} from '../src/modules/price-lists/application/use-cases/price-lists.use-cases';
import {
  CreateAgreementUseCase,
  ListAgreementsUseCase,
} from '../src/modules/agreements/application/use-cases/agreements.use-cases';
import {
  AssignPatientAgreementUseCase,
  GetPatientAgreementUseCase,
} from '../src/modules/patient-agreements/application/use-cases/patient-agreements.use-cases';
import { UpdateCatalogItemUseCase } from '../src/modules/dental-catalog/application/use-cases/update-catalog-item.use-case';
import { CreatePatientUseCase } from '../src/modules/patients/application/use-cases/create-patient.use-case';
import { CreateResponsiblePartyUseCase } from '../src/modules/patients/application/use-cases/responsible-parties.use-cases';
import { PublishPrivacyPolicyUseCase } from '../src/modules/data-consents/application/use-cases/publish-privacy-policy.use-case';
import { RecordDataConsentsUseCase } from '../src/modules/data-consents/application/use-cases/record-data-consents.use-case';
import type { ConsentDecision } from '../src/modules/data-consents/domain/entities/data-consent.entity';
import { CreateClinicalEntryUseCase } from '../src/modules/clinical-entries/application/use-cases/create-clinical-entry.use-case';
import { CreateClinicalEntryAddendumUseCase } from '../src/modules/clinical-entries/application/use-cases/create-clinical-entry-addendum.use-case';
import { AddToothRecordUseCase } from '../src/modules/odontogram/application/use-cases/add-tooth-record.use-case';
import { RecordDentitionEventsUseCase } from '../src/modules/odontogram/application/use-cases/dentition.use-cases';
import { VoidToothRecordUseCase } from '../src/modules/odontogram/application/use-cases/void-tooth-record.use-case';
import { CreateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/create-appointment.use-case';
import {
  UpdateAppointmentUseCase,
  type CancellationRequest,
} from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import { CreateCancellationPolicyVersionUseCase } from '../src/modules/cancellation-policies/application/use-cases/cancellation-policy.use-cases';
import { OVERLAP_MESSAGES } from '../src/modules/appointments/application/appointment-overlap-error';
import { ListAppointmentsUseCase } from '../src/modules/appointments/application/use-cases/list-appointments.use-case';
import { CreateAppointmentTypeUseCase } from '../src/modules/appointment-types/application/use-cases/appointment-types.use-cases';
import { LoadSampleNoteTemplatesUseCase } from '../src/modules/clinical-note-templates/application/use-cases/clinical-note-templates.use-cases';
import { AnestheticCatalogUseCases } from '../src/modules/anesthesia/application/use-cases/anesthetic-catalog.use-cases';
import { AnesthesiaUseCases } from '../src/modules/anesthesia/application/use-cases/anesthesia.use-cases';
import { SedationUseCases } from '../src/modules/sedation/application/use-cases/sedation.use-cases';
import { PLATFORM_SEDATION_TEMPLATE } from '../src/modules/sedation/domain/sedation-template';
import { UpdateReminderSettingsUseCase } from '../src/modules/reminders/application/use-cases/reminder-settings.use-cases';
import { CreateConfirmationLinkUseCase } from '../src/modules/appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import { RespondConfirmationUseCase } from '../src/modules/appointment-confirmations/application/use-cases/respond-confirmation.use-case';
import { CreateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/create-treatment-plan.use-case';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { UpdateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import { RemoveTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/remove-treatment-plan-item.use-case';
import { CreatePlanAlternativeUseCase } from '../src/modules/treatment-plans/application/use-cases/create-plan-alternative.use-case';
import { PresentTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/present-treatment-plan.use-case';
import {
  TREATMENT_PLAN_REPOSITORY,
  type TreatmentPlanRepository,
} from '../src/modules/treatment-plans/domain/ports/treatment-plan-repository.port';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { GetPaymentAllocationsUseCase } from '../src/modules/payments/application/use-cases/get-payment-allocations.use-case';
import { RecordPaymentUseCase } from '../src/modules/payments/application/use-cases/record-payment.use-case';
import { CreatePaymentMethodUseCase } from '../src/modules/payment-methods/application/payment-methods.use-cases';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  CreateCollectionNoteUseCase,
  CreatePaymentPromiseUseCase,
} from '../src/modules/collections/application/use-cases/collections.use-cases';
import { ReplacePaymentAllocationsUseCase } from '../src/modules/payments/application/use-cases/replace-payment-allocations.use-case';
import { VoidPaymentUseCase } from '../src/modules/payments/application/use-cases/void-payment.use-case';
import {
  CloseCashSessionUseCase,
  OpenCashSessionUseCase,
} from '../src/modules/cash-sessions/application/use-cases/cash-sessions.use-cases';
import { CreateCashOutflowUseCase } from '../src/modules/expenses/application/use-cases/create-cash-outflow.use-case';
import { CreateExpenseUseCase } from '../src/modules/expenses/application/use-cases/create-expense.use-case';
import { CreatePaymentPlanUseCase } from '../src/modules/payment-plans/application/use-cases/create-payment-plan.use-case';
import { CreateInventoryItemUseCase } from '../src/modules/inventory/application/use-cases/create-inventory-item.use-case';
import { RecordInventoryMovementUseCase } from '../src/modules/inventory/application/use-cases/record-inventory-movement.use-case';
import { CreateConsentTemplateUseCase } from '../src/modules/consents/application/use-cases/consent-templates.use-cases';
import { SignPatientConsentUseCase } from '../src/modules/consents/application/use-cases/patient-consents.use-cases';
import { CreatePrescriptionTemplateUseCase } from '../src/modules/prescriptions/application/use-cases/prescription-templates.use-cases';
import { IssuePrescriptionUseCase } from '../src/modules/prescriptions/application/use-cases/prescriptions.use-cases';
import { UpdatePrescriptionSettingsUseCase } from '../src/modules/prescriptions/application/use-cases/prescription-settings.use-cases';
import { RegisterImplantUseCase } from '../src/modules/implants/application/use-cases/implants.use-cases';
import { UpdateStaffUseCase } from '../src/modules/staff/application/use-cases/update-staff.use-case';
import { ReplaceStaffLocationsUseCase } from '../src/modules/staff/application/use-cases/staff-locations.use-cases';
import {
  CreatePerioExamUseCase,
  FinalizePerioExamUseCase,
  SavePerioMeasuresUseCase,
} from '../src/modules/periodontal/application/use-cases/perio-exams.use-cases';
import {
  DemoLocationKey,
  DEMO_TIMEZONE,
  daysAgoAt,
  daysUntilMondayAfterNext,
  daysUntilNextWeekday,
  daysUntilRotationCover,
  planAppointments,
  planComparisonHistory,
  planInClinicToday,
} from './demo/calendar';
import { CreateScheduleBlockUseCase } from '../src/modules/schedule-blocks/application/use-cases/schedule-blocks.use-cases';
import {
  CreateWaitlistEntryUseCase,
  DismissWaitlistEntryUseCase,
  ListWaitlistUseCase,
} from '../src/modules/waitlist/application/use-cases/waitlist.use-cases';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { ConfirmAnamnesisNoChangesUseCase } from '../src/modules/medical-history/application/use-cases/medical-alerts.use-cases';
import { deriveSafetyFlags } from '../src/modules/medical-history/domain/safety-flags';
import type { MedicalHistoryVersionData } from '../src/modules/medical-history/domain/ports/medical-history-repository.port';
import {
  ReplaceProviderScheduleUseCase,
  SetProviderOverrideUseCase,
} from '../src/modules/provider-schedule/application/use-cases/provider-schedule.use-cases';
import {
  LoadSamplePostOpTemplatesUseCase,
  UpdatePostOpTemplateUseCase,
} from '../src/modules/post-op-instructions/application/use-cases/post-op-templates.use-cases';
import { DeliverPostOpInstructionsUseCase } from '../src/modules/post-op-instructions/application/use-cases/post-op-deliveries.use-cases';
import { CreateAnamnesisRequestUseCase } from '../src/modules/medical-history-submissions/application/use-cases/anamnesis-requests.use-cases';
import { SubmitPublicAnamnesisUseCase } from '../src/modules/medical-history-submissions/application/use-cases/public-anamnesis.use-cases';
import {
  CreatePayerUseCase,
  ListPayersUseCase,
} from '../src/modules/payers/application/use-cases/payers.use-cases';
import {
  CreatePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  VerifyPatientCoverageUseCase,
} from '../src/modules/patient-coverages/application/use-cases/patient-coverages.use-cases';
import { UpdatePatientCommunicationUseCase } from '../src/modules/patients/application/use-cases/patient-communication.use-cases';
import {
  DEMO_ANAMNESIS_SUBMISSION,
  DEMO_CLINIC_NAME,
  DEMO_CLINICAL_ENTRIES,
  DEMO_CLINICAL_ADDENDA,
  DEMO_COMMUNICATION,
  DEMO_TEMPLATE_EVOLUTIONS,
  DEMO_ANESTHESIA,
  DEMO_SEDATION,
  DEMO_CONSENT_TEMPLATES,
  DEMO_APPOINTMENT_TYPES,
  DEMO_LUNCH,
  DEMO_ROTATION,
  DEMO_VACATION,
  DEMO_WAITLIST,
  DEMO_PERIO,
  DEMO_IMPLANTS,
  DEMO_PRESCRIPTION,
  DEMO_PRESCRIPTION_TEMPLATES,
  DEMO_PROFESSIONAL_LICENSES,
  DEMO_PROFESSIONAL_SPECIALTIES,
  DEMO_PRESCRIPTION_SETTINGS,
  demoPerioMeasures,
  DEMO_CURRENCY,
  DEMO_HOUR_CYCLE,
  DEMO_COMPARISON_HISTORY,
  DEMO_EMAIL_DOMAIN,
  DEMO_INVENTORY,
  DEMO_LOCATIONS,
  DEMO_PASSWORD,
  DEMO_PATIENTS,
  DEMO_PAYERS,
  DEMO_COVERAGES,
  DEMO_RESPONSIBLES,
  DEMO_PLANS,
  DEMO_CASH_OUTFLOW,
  type DemoPlan,
  type DemoPlanItem,
  DEMO_COLLECTION_NOTES,
  DEMO_EXPENSES,
  DEMO_PAYMENT_PROMISE,
  DEMO_PLAN_OPTIONS,
  DEMO_CANCELLATION,
  DEMO_MEDICAL_ALERTS,
  DEMO_PRICES,
  DEMO_ALFA_PAYER,
  DEMO_PRICE_LISTS,
  DEMO_AGREEMENTS,
  DEMO_PATIENT_AGREEMENTS,
  DEMO_PRINCIPAL_PHONE,
  DEMO_POSTOP,
  DEMO_PRIMARY_COLOR,
  DEMO_PRIVACY_POLICY,
  DEMO_SIGNED_CONSENT,
  DEMO_SUBDOMAIN,
  DEMO_TOOTH_RECORDS,
  DEMO_TOOTH_RECORD_VOIDS,
  DEMO_PEDIATRIC,
  DEMO_USERS,
  NORTE_SCHEDULE,
} from './demo/data';
import {
  DEMO_PATIENT_SIGNATURE_PNG,
  DEMO_PROFESSIONAL_SIGNATURE_PNG,
} from './demo/signatures';

export {
  DEMO_EMAIL_DOMAIN,
  DEMO_PASSWORD,
  DEMO_SUBDOMAIN,
  DEMO_USERS,
} from './demo/data';

/*
 * Seed de la clínica DEMO para probar el producto en local
 * (http://demo.localhost:3001). Uso: `npm run seed:demo [-- --reset]`.
 *
 * SOLO LOCAL: carga `.env` y se niega a correr si NODE_ENV=production (sin
 * excepción) o si el host de DATABASE_URL no es localhost/127.0.0.1/::1, salvo
 * ALLOW_DEMO_SEED=1 (que solo levanta la comprobación de host). Lo comprueba
 * antes de levantar la app y otra vez después, con la configuración ya cargada.
 *
 * IDEMPOTENCIA — "si el tenant demo ya existe, no hace nada":
 *   - Sin flags: si hay un tenant vivo con subdominio `demo` creado por este
 *     seed, no toca nada y solo vuelve a imprimir las credenciales.
 *   - `--reset`: retira EN BLANDO la demo anterior (tenant, membresías y
 *     usuarios @demo.dentalix.app con `deletedAt`, igual que el resto del
 *     producto: aquí nada se borra en duro) y la reconstruye con fechas
 *     relativas al hoy nuevo. Es lo que hay que correr cuando la agenda demo
 *     "envejece".
 *   - Un tenant `demo` que NO creó este seed (sin admin@demo.dentalix.app como
 *     ADMIN vivo) nunca se toca: aborta con error, con o sin --reset. Tampoco se
 *     retiran usuarios demo que sean miembros vivos de otra clínica.
 *   - Si una corrida falla a medias, la demo incompleta se retira sola, así que
 *     la siguiente corrida empieza limpia.
 *
 * CONEXIÓN — por qué NO usa DIRECT_URL: todo pasa por la app real
 * (`NestFactory.createApplicationContext(AppModule)`), es decir, por
 * `PrismaService` con DATABASE_URL (rol `dentalix_app`, sujeto a RLS) y los
 * MISMOS casos de uso que llaman los controladores: registro de clínica,
 * invitación + aceptación, sedes, horarios, pacientes, planes, abonos, etc.
 * Toda escritura en tablas de CLÍNICA corre en `runWithTenant` con
 * `app.current_tenant` fijado, así que el WITH CHECK de RLS hace imposible que
 * una de esas filas caiga fuera del tenant demo. Las únicas escrituras fuera de
 * `runWithTenant` son a las tablas GLOBALES sin RLS — `tenants` (registro,
 * branding, retiro) y `users` (registro, aceptación de invitación, retiro) — y
 * van acotadas por el id del tenant demo o por los correos @demo.dentalix.app.
 * Las reglas de negocio (horario de la sede, solapes, pertenencia, precios del
 * catálogo, cuotas, hashing argon2...) son exactamente las del producto. Las
 * citas YA pasadas van por `CreateAppointmentUseCase.registerHistorical`, que
 * aplica las mismas validaciones salvo "no agendar en el pasado".
 */

export type DemoSeedStatus = 'created' | 'skipped' | 'rebuilt';

/** DX-170: cita atendida de la demo, para ligarle una evolución. */
interface AttendedAppointment {
  id: string;
  patientId: string;
  providerId: string;
  start: Date;
}

export interface DemoSeedOptions {
  /** Retira la demo existente (en blando) y la reconstruye. */
  reset?: boolean;
  /** No imprime el resumen (tests). */
  quiet?: boolean;
}

export interface DemoSeedResult {
  status: DemoSeedStatus;
  tenantId: string;
  url: string;
  /** La misma para todos los usuarios demo. */
  password: string;
  users: { email: string; role: string }[];
  /**
   * Enlace público de la cita con confirmación pendiente (DX-005). Solo al
   * crear/reconstruir: el token en claro no se guarda, así que una corrida
   * `skipped` no puede volver a mostrarlo.
   */
  confirmationUrl?: string;
}

const DEMO_URL = `http://${DEMO_SUBDOMAIN}.localhost:3001`;
/** Las citas que empiezan antes de esto se tratan como pasadas (margen de reloj). */
const FUTURE_MARGIN_MS = 5 * 60 * 1000;
const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/** Lanza si el entorno no es una base local de desarrollo/pruebas. */
export function assertLocalEnvironment(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  ALLOW_DEMO_SEED?: string;
}): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'seed:demo se niega a correr con NODE_ENV=production: solo es para entornos locales.',
    );
  }
  if (env.ALLOW_DEMO_SEED === '1') return;
  if (!env.DATABASE_URL) {
    throw new Error('seed:demo: falta DATABASE_URL.');
  }
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    throw new Error('seed:demo: DATABASE_URL no es una URL válida.');
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `seed:demo se niega a escribir en una base que no es local (host "${host}"); ` +
        'solo acepta localhost/127.0.0.1/::1. Si es un entorno de pruebas desechable, ' +
        'exporta ALLOW_DEMO_SEED=1.',
    );
  }
}

export async function seedDemo(
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  // `.env` ANTES de la guarda: si no, la app lo cargaría después y la guarda
  // habría mirado otra base. No pisa variables ya definidas.
  loadDotenv({ quiet: true });
  assertLocalEnvironment(process.env);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    // Re-comprobación con la configuración que de verdad usa la app.
    const config = app.get(ConfigService);
    assertLocalEnvironment({
      NODE_ENV: config.get<string>('NODE_ENV'),
      DATABASE_URL: config.get<string>('DATABASE_URL'),
      ALLOW_DEMO_SEED: config.get<string>('ALLOW_DEMO_SEED'),
    });

    const seeder = new DemoSeeder(app);
    const existing = await seeder.findLiveDemoTenantId();
    if (existing) await seeder.assertSeedOwned(existing);

    let status: DemoSeedStatus;
    let tenantId: string;
    let confirmationUrl: string | undefined;
    if (existing && !options.reset) {
      status = 'skipped';
      tenantId = existing;
    } else {
      if (existing) await seeder.retire(existing);
      ({ tenantId, confirmationUrl } = await seeder.build());
      status = existing ? 'rebuilt' : 'created';
    }

    const result: DemoSeedResult = {
      status,
      tenantId,
      url: DEMO_URL,
      password: DEMO_PASSWORD,
      users: DEMO_USERS.map((u) => ({ email: u.email, role: u.role })),
      ...(confirmationUrl ? { confirmationUrl } : {}),
    };
    if (!options.quiet) printSummary(result);
    return result;
  } finally {
    await app.close();
  }
}

/** El mismo instante `months` meses de calendario antes (DX-247: anamnesis antigua). */
function monthsBefore(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  out.setUTCMonth(out.getUTCMonth() - months);
  return out;
}

class DemoSeeder {
  private readonly prisma: PrismaService;
  private readonly tenantContext: TenantContextService;
  /** "Hoy" de referencia para fechar los datos (no para decidir pasado/futuro). */
  private readonly now = new Date();
  private mobileMethodId: string | null = null;

  constructor(private readonly app: INestApplicationContext) {
    this.prisma = app.get(PrismaService);
    this.tenantContext = app.get(TenantContextService);
  }

  private use<T>(type: Type<T>): T {
    return this.app.get(type, { strict: false });
  }

  async findLiveDemoTenantId(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { subdomain: DEMO_SUBDOMAIN, deletedAt: null },
      select: { id: true },
    });
    return tenant?.id ?? null;
  }

  /** El tenant `demo` es de este seed si su admin demo sigue siendo ADMIN vivo. */
  async assertSeedOwned(tenantId: string): Promise<void> {
    const owner = DEMO_USERS[0];
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: {
          tenantId,
          role: ClinicRole.ADMIN,
          deletedAt: null,
          user: { email: owner.email, deletedAt: null },
        },
        select: { id: true },
      }),
    );
    if (!membership) {
      throw new Error(
        `El tenant con subdominio "${DEMO_SUBDOMAIN}" (${tenantId}) no lo creó seed:demo ` +
          `(no tiene a ${owner.email} como ADMIN vivo), así que no se toca. ` +
          'Si quieres la demo, retira o renombra ese tenant a mano.',
      );
    }
  }

  private async liveDemoUserIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` }, deletedAt: null },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Aborta si algún usuario demo es miembro vivo de una clínica distinta de
   * `demoTenantId`. `clinic_memberships` tiene RLS y aquí no hay bypass, así que
   * se mira tenant a tenant (en local son pocos).
   */
  private async assertDemoUsersExclusive(
    userIds: string[],
    demoTenantId: string | null,
  ): Promise<void> {
    if (userIds.length === 0) return;
    const others = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        ...(demoTenantId ? { id: { not: demoTenantId } } : {}),
      },
      select: { id: true, subdomain: true },
    });
    for (const other of others) {
      const count = await this.prisma.runWithTenant(other.id, (tx) =>
        tx.clinicMembership.count({
          where: {
            tenantId: other.id,
            userId: { in: userIds },
            deletedAt: null,
          },
        }),
      );
      if (count > 0) {
        throw new Error(
          `Hay usuarios @${DEMO_EMAIL_DOMAIN} que también son miembros vivos de ` +
            `"${other.subdomain}"; seed:demo no los retira. Quítalos de esa clínica a mano.`,
        );
      }
    }
  }

  /** Retiro en blando de una demo y de sus usuarios (comprobado antes de escribir). */
  async retire(tenantId: string): Promise<void> {
    const userIds = await this.liveDemoUserIds();
    await this.assertDemoUsersExclusive(userIds, tenantId);
    const at = new Date();
    await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: at },
      }),
    );
    await this.prisma.user.updateMany({
      where: { id: { in: userIds } },
      data: { deletedAt: at },
    });
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { deletedAt: at },
    });
  }

  async build(): Promise<{ tenantId: string; confirmationUrl?: string }> {
    // Usuarios demo huérfanos (p. ej. de un tenant retirado a mano) impedirían
    // el registro: se retiran, siempre que no pertenezcan a otra clínica.
    const orphans = await this.liveDemoUserIds();
    await this.assertDemoUsersExclusive(orphans, null);
    if (orphans.length > 0) {
      await this.prisma.user.updateMany({
        where: { id: { in: orphans } },
        data: { deletedAt: new Date() },
      });
    }

    const owner = DEMO_USERS[0];
    // El MISMO alta que completa el enlace del registro (DX-029): tenant +
    // dueño ADMIN + "Sede principal" con horario por defecto + catálogo
    // semilla, en una sola transacción. La demo la crea el operador, sin
    // email que verificar: los correos demo se dan por verificados.
    const authRepo = this.app.get<AuthRepository>(AUTH_REPOSITORY, {
      strict: false,
    });
    const { tenantId, userId: ownerId } = await authRepo.createClinicWithOwner({
      clinicName: DEMO_CLINIC_NAME,
      subdomain: DEMO_SUBDOMAIN,
      email: owner.email,
      passwordHash: await this.use(PasswordService).hash(DEMO_PASSWORD),
      fullName: owner.fullName,
      emailVerifiedAt: new Date(),
      // G1: la demo es dato de prueba con país, moneda, zona y formato
      // EXPLÍCITOS (nada se deduce); nace revisada, sin aviso D5. G1-B: y
      // su reloj, sin pasar por la función de backfill (spec G1-B §4.5).
      location: {
        country: 'CO',
        currency: DEMO_CURRENCY,
        timeZone: DEMO_TIMEZONE,
        locale: 'es-CO',
        hourCycle: DEMO_HOUR_CYCLE,
      },
      // DX-359: el alta queda auditada, sin petición detrás.
      request: null,
    });

    let confirmationUrl: string | undefined;
    try {
      confirmationUrl = await this.populate(tenantId, ownerId);
    } catch (error) {
      try {
        await this.retire(tenantId);
      } catch (retireError) {
        console.error(
          `No se pudo retirar la demo incompleta ${tenantId}; usa --reset:`,
          retireError,
        );
      }
      throw error;
    }
    return { tenantId, confirmationUrl };
  }

  /**
   * DX-377: el medio demo «Pago móvil» (tipo digital, pide referencia), además
   * de los 4 iniciales que el alta ya creó. Nombre genérico: ni país ni banco.
   */
  private async mobilePaymentMethod(
    tenantId: string,
    ownerId: string,
  ): Promise<string> {
    if (this.mobileMethodId) return this.mobileMethodId;
    const created = await this.inTenant(tenantId, undefined, () =>
      this.use(CreatePaymentMethodUseCase).execute(
        { name: 'Pago móvil', kind: 'DIGITAL', requiresReference: true },
        ownerId,
      ),
    );
    this.mobileMethodId = created.id;
    return created.id;
  }

  private inTenant<T>(
    tenantId: string,
    locationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tenantContext.run(tenantId, locationId, fn);
  }

  /** Devuelve el enlace de la confirmación pendiente (ver `requestConfirmations`). */
  private async populate(
    tenantId: string,
    ownerId: string,
  ): Promise<string | undefined> {
    // Branding (no hay caso de uso de edición; `tenants` no tiene RLS).
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryColor: DEMO_PRIMARY_COLOR },
    });

    const userIds = await this.inTenant(tenantId, undefined, () =>
      this.inviteStaff(ownerId),
    );
    const dentists = [userIds[1], userIds[2]];
    const receptionId = userIds[3];

    const locations = await this.inTenant(tenantId, undefined, () =>
      this.setUpLocations(tenantId),
    );
    await this.inTenant(tenantId, undefined, () =>
      this.restrictStaffLocations(ownerId, userIds, locations),
    );
    const hours = await this.readBusinessHours(tenantId, locations);

    const catalog = await this.inTenant(tenantId, undefined, () =>
      this.priceCatalog(tenantId),
    );

    // DX-037: la política v1 la publica el ADMIN antes de dar de alta a nadie,
    // para que cada alta registre la autorización contra ella.
    const policy = await this.inTenant(tenantId, undefined, () =>
      this.use(PublishPrivacyPolicyUseCase).execute(
        DEMO_PRIVACY_POLICY,
        ownerId,
      ),
    );

    const patientIds = await this.inTenant(tenantId, undefined, () =>
      this.createPatients(receptionId, dentists[0], policy.id),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createBackdatedAnamneses(tenantId, patientIds, dentists[1]),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createClinicalRecords(patientIds, dentists, catalog),
    );

    const typeByReason = await this.inTenant(tenantId, undefined, () =>
      this.createAppointmentTypes(ownerId),
    );

    // DX-233: antes de las citas, para que las suyas caigan en su horario.
    await this.inTenant(tenantId, undefined, () =>
      this.createProviderRotation(tenantId, locations, dentists, ownerId),
    );

    const attended = await this.createAppointments(
      tenantId,
      locations,
      hours,
      patientIds,
      dentists,
      receptionId,
      typeByReason,
    );

    await this.createCancellationPolicy(
      tenantId,
      locations,
      hours,
      patientIds,
      dentists,
      ownerId,
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createTemplateEvolutions(ownerId, attended),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createAnesthesia(ownerId, patientIds, dentists[0]),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createSedation(patientIds, dentists[0], userIds[4]),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createPostOpInstructions(
        tenantId,
        ownerId,
        catalog,
        typeByReason,
        attended,
      ),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createAnamnesisSubmission(tenantId, patientIds, receptionId),
    );

    await this.createScheduleBlocksAndWaitlist(
      tenantId,
      locations,
      patientIds,
      dentists,
      receptionId,
    );

    await this.createInClinicToday(
      tenantId,
      locations,
      hours,
      patientIds,
      dentists,
      receptionId,
    );

    await this.createPlansAndPayments(
      tenantId,
      locations,
      patientIds,
      dentists,
      receptionId,
      catalog,
      ownerId,
    );

    await this.createComparisonHistory(
      tenantId,
      locations,
      patientIds,
      dentists,
      receptionId,
      catalog,
    );

    await this.createPlanOptions(
      tenantId,
      locations,
      patientIds,
      dentists,
      catalog,
    );

    await this.createCollections(tenantId, locations, patientIds, receptionId);

    await this.createCashSessions(tenantId, locations, receptionId);

    await this.createExpenses(tenantId, locations, ownerId, receptionId);

    await this.createInventory(tenantId, locations, userIds[4]);

    await this.inTenant(tenantId, undefined, () =>
      this.createConsents(ownerId, patientIds, dentists),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createPerioExams(patientIds, dentists),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createPrescriptions(ownerId, patientIds, dentists),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createImplants(patientIds, dentists),
    );

    // DX-105 al final: una lista activa en la Sede Norte o un convenio asignado
    // re-precian los ítems que se añadan después, y los planes de la demo ya
    // están fijados con sus precios de catálogo.
    await this.inTenant(tenantId, undefined, () =>
      this.createAgreements(
        locations,
        patientIds,
        catalog,
        receptionId,
        ownerId,
      ),
    );

    // DX-051 al final: cualquier paso anterior que cobre o cambie ítems deja
    // su plan en la cola, y la demo termina con la cola vacía.
    await this.allocatePayments(tenantId, ownerId);

    return this.requestConfirmations(tenantId, receptionId);
  }

  /**
   * DX-005: las dos próximas citas agendadas reciben enlace de confirmación
   * por los mismos casos de uso que la API. La primera queda PENDIENTE (se
   * devuelve su enlace para probar la página pública); en la segunda el
   * paciente ya pulsó "Quiero que me llamen", así que la agenda la muestra con
   * el indicador "pide llamada".
   */
  private async requestConfirmations(
    tenantId: string,
    receptionId: string,
  ): Promise<string | undefined> {
    const upcoming = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.appointment.findMany({
        where: {
          deletedAt: null,
          status: AppointmentStatus.SCHEDULED,
          start: { gt: new Date(Date.now() + FUTURE_MARGIN_MS) },
        },
        orderBy: { start: 'asc' },
        take: 2,
        select: { id: true, locationId: true },
      }),
    );

    const links: string[] = [];
    for (const appointment of upcoming) {
      const { token } = await this.inTenant(
        tenantId,
        appointment.locationId,
        () =>
          this.use(CreateConfirmationLinkUseCase).execute({
            appointmentId: appointment.id,
            createdById: receptionId,
          }),
      );
      links.push(token);
    }
    const [pending, callMe] = links;
    if (callMe) {
      await this.inTenant(tenantId, undefined, () =>
        this.use(RespondConfirmationUseCase).execute(callMe, 'call_me'),
      );
    }
    return pending ? `${DEMO_URL}/confirmar/${pending}` : undefined;
  }

  /** Equipo por el flujo real: invitación del admin + aceptación con contraseña. */
  private async inviteStaff(ownerId: string): Promise<string[]> {
    const ids = [ownerId];
    for (const member of DEMO_USERS.slice(1)) {
      // DX-359: auditado como la invitación del ADMIN.
      const { token } = await this.use(CreateInvitationUseCase).execute(
        {
          fullName: member.fullName,
          email: member.email,
          role: member.role,
          invitedById: ownerId,
        },
        {
          tenantId: this.tenantContext.getTenantId() as string,
          locationId: null,
          actor: { userId: ownerId, role: ClinicRole.ADMIN },
          requestId: null,
          ip: null,
          userAgent: null,
        },
      );
      await this.use(AcceptInvitationUseCase).execute({
        token,
        password: DEMO_PASSWORD,
      });
      const user = await this.prisma.user.findFirstOrThrow({
        where: { email: member.email, deletedAt: null },
        select: { id: true },
      });
      ids.push(user.id);
    }
    return ids;
  }

  /**
   * DX-089: los miembros con `locations` quedan restringidos a esas sedes por
   * el mismo caso de uso que `PUT /staff/:userId/locations` (el resto, sin
   * filas, atiende en todas). Va después de crear las sedes.
   */
  private async restrictStaffLocations(
    ownerId: string,
    userIds: string[],
    locations: Record<DemoLocationKey, string>,
  ): Promise<void> {
    for (const [index, member] of DEMO_USERS.entries()) {
      if (!member.locations) continue;
      await this.use(ReplaceStaffLocationsUseCase).execute({
        userId: userIds[index],
        locationIds: member.locations.map((key) => locations[key]),
        actorUserId: ownerId,
      });
    }
  }

  private async setUpLocations(
    tenantId: string,
  ): Promise<Record<DemoLocationKey, string>> {
    const principal = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findFirstOrThrow({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    );
    await this.use(UpdateLocationUseCase).execute(principal.id, {
      address: DEMO_LOCATIONS.principal.address,
      // DX-222: el de urgencias en las indicaciones postoperatorias.
      phone: DEMO_PRINCIPAL_PHONE,
    });
    // Nace con el horario por defecto (como cualquier sede nueva) y luego se
    // le pone el suyo con el caso de uso de /settings/horarios.
    const norte = await this.use(CreateLocationUseCase).execute({
      ...DEMO_LOCATIONS.norte,
      country: 'CO',
      currency: DEMO_CURRENCY,
      timeZone: DEMO_TIMEZONE,
      locale: 'es-CO',
      hourCycle: DEMO_HOUR_CYCLE,
    });
    await this.inTenant(tenantId, norte.id, () =>
      this.use(ReplaceLocationScheduleUseCase).execute({
        ranges: NORTE_SCHEDULE,
      }),
    );
    // DX-026: la principal manda recordatorios por email 48 h y 2 h antes; la
    // Norte se queda como cualquier sede nueva (desactivados).
    await this.use(UpdateReminderSettingsUseCase).execute(principal.id, {
      enabled: true,
      leadHours: [48, 2],
    });
    return { principal: principal.id, norte: norte.id };
  }

  private async readBusinessHours(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
  ): Promise<Record<DemoLocationKey, BusinessHours | null>> {
    const read = (key: DemoLocationKey) =>
      this.inTenant(tenantId, locations[key], () =>
        this.use(GetLocationScheduleUseCase).execute(),
      );
    return { principal: await read('principal'), norte: await read('norte') };
  }

  /**
   * DX-105: listas de precios, convenios y su asignación a tres pacientes, por
   * los mismos casos de uso que la API. Idempotente: lista, convenio y
   * pagador se buscan por nombre y la asignación se salta si el paciente ya
   * tiene una viva.
   */
  private async createAgreements(
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    catalog: Map<string, string>,
    receptionId: string,
    ownerId: string,
  ): Promise<void> {
    const payers = await this.use(ListPayersUseCase).execute({
      includeInactive: true,
    });
    const alfaPayer =
      payers.find((p) => p.name === DEMO_ALFA_PAYER.name) ??
      (await this.use(CreatePayerUseCase).execute(
        { name: DEMO_ALFA_PAYER.name, type: DEMO_ALFA_PAYER.type },
        receptionId,
      ));
    const payerIds = new Map(payers.map((p) => [p.name, p.id]));
    payerIds.set(alfaPayer.name, alfaPayer.id);

    const existingLists = await this.use(ListPriceListsUseCase).execute({
      includeInactive: true,
    });
    const listIds = new Map<string, string>();
    for (const spec of DEMO_PRICE_LISTS) {
      let id = existingLists.find((l) => l.name === spec.name)?.id;
      if (!id) {
        const created = await this.use(CreatePriceListUseCase).execute(
          {
            name: spec.name,
            currency: DEMO_CURRENCY,
            locationId: spec.locationKey ? locations[spec.locationKey] : null,
          },
          receptionId,
        );
        id = created.id;
        await this.use(ReplacePriceListItemsUseCase).execute(
          id,
          Object.entries(spec.prices).map(([code, price]) => ({
            catalogItemId: catalogId(catalog, code),
            price,
          })),
        );
      }
      listIds.set(spec.key, id);
    }

    const existingAgreements = await this.use(ListAgreementsUseCase).execute({
      includeInactive: true,
    });
    const agreementIds = new Map<string, string>();
    for (const spec of DEMO_AGREEMENTS) {
      const id =
        existingAgreements.find((a) => a.name === spec.name)?.id ??
        (
          await this.use(CreateAgreementUseCase).execute(
            {
              name: spec.name,
              payerId: payerIds.get(spec.payerName) as string,
              kind: spec.kind,
              percent: spec.percent,
              priceListId: spec.priceListKey
                ? listIds.get(spec.priceListKey)
                : null,
            },
            receptionId,
          )
        ).id;
      agreementIds.set(spec.key, id);
    }

    // SEC-047: un convenio de pagador solo se asigna con una cobertura viva
    // del paciente con ese pagador; si la demo no se la dio (Alfa), recepción
    // la añade antes, como haría en la ficha. SEC-049: recepción la registró,
    // así que el ADMIN la verifica antes de que recepción asigne el convenio.
    for (const a of DEMO_PATIENT_AGREEMENTS) {
      const patientId = patientIds[a.patientIndex];
      const current = await this.use(GetPatientAgreementUseCase).execute(
        patientId,
        false,
      );
      if (current.current) continue;
      const spec = DEMO_AGREEMENTS.find((s) => s.key === a.agreementKey);
      const payerId = payerIds.get(spec?.payerName ?? '') as string;
      const coverages = await this.use(ListPatientCoveragesUseCase).execute(
        patientId,
      );
      const coverage =
        coverages.find((c) => c.payer.id === payerId) ??
        (await this.use(CreatePatientCoverageUseCase).execute(
          patientId,
          {
            payerId,
            planName: a.coverage.planName,
            memberNumber: a.coverage.memberNumber,
            isPrimary: false,
          },
          receptionId,
        ));
      const coverageId = coverage.id;
      if (coverage.verifiedAt === null && coverage.memberNumber !== null) {
        await this.use(VerifyPatientCoverageUseCase).execute(
          patientId,
          coverageId,
          coverage.memberNumber,
          ownerId,
        );
      }
      await this.use(AssignPatientAgreementUseCase).execute(
        patientId,
        { agreementId: agreementIds.get(a.agreementKey) as string, coverageId },
        { userId: receptionId, role: ClinicRole.RECEPTION },
      );
    }
  }

  /** Tarifas COP en el catálogo por defecto; devuelve código → id. */
  private async priceCatalog(tenantId: string): Promise<Map<string, string>> {
    const items = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.dentalCatalogItem.findMany({
        where: { deletedAt: null },
        select: { id: true, code: true },
      }),
    );
    const byCode = new Map(items.map((i) => [i.code, i.id]));
    for (const [code, price] of Object.entries(DEMO_PRICES)) {
      await this.use(UpdateCatalogItemUseCase).execute(
        catalogId(byCode, code),
        {
          defaultPrice: price,
        },
      );
    }
    return byCode;
  }

  /**
   * Autorizaciones de la demo (DX-037), para ver los tres estados en la ficha:
   * todos autorizan datos generales y de salud; los pares además aceptan
   * comunicaciones comerciales, y el segundo paciente las acepta en el alta y
   * las revoca después (historial con dos filas MARKETING).
   */
  private async createPatients(
    receptionId: string,
    dentistId: string,
    policyVersionId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    const backdated = new Set<number>(
      DEMO_MEDICAL_ALERTS.backdated.map((b) => b.patientIndex),
    );
    for (const [index, p] of DEMO_PATIENTS.entries()) {
      const { city: cityName, birthDate, ...withHistory } = p;
      // DX-247: la anamnesis antigua la siembra `createBackdatedAnamneses`.
      const rest = backdated.has(index)
        ? { ...withHistory, medicalHistory: undefined }
        : withHistory;
      const city = await this.prisma.city.findFirst({
        where: { countryCode: 'CO', name: cityName },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const revokesMarketing = index === 1;
      const decisions: ConsentDecision[] = [
        { scope: 'GENERAL', granted: true },
        { scope: 'SENSITIVE_HEALTH', granted: true },
        ...(index % 2 === 0 || revokesMarketing
          ? [{ scope: 'MARKETING' as const, granted: true }]
          : []),
      ];
      const patient = await this.use(CreatePatientUseCase).execute({
        ...rest,
        birthDate: new Date(`${birthDate}T00:00:00.000Z`),
        countryCode: city ? 'CO' : undefined,
        cityId: city?.id,
        dataConsents: { policyVersionId, decisions },
        // SEC-005: la anamnesis inicial solo la escribe un rol clínico. El
        // paciente que llega con anamnesis lo da de alta el odontólogo; el
        // resto, recepción (mostrador), sin historia clínica.
        ...(withHistory.medicalHistory
          ? { createdById: dentistId, actorRole: ClinicRole.DENTIST }
          : { createdById: receptionId, actorRole: ClinicRole.RECEPTION }),
      });
      if (revokesMarketing) {
        await this.use(RecordDataConsentsUseCase).execute(
          patient.id,
          {
            policyVersionId,
            decisions: [{ scope: 'MARKETING', granted: false }],
          },
          receptionId,
          {},
        );
      }
      ids.push(patient.id);
    }
    // DX-128: preferencias de comunicación, como las registraría recepción.
    const ctx: AuditRequestContext = {
      tenantId: this.tenantContext.getTenantId() as string,
      locationId: null,
      actor: { userId: receptionId, role: ClinicRole.RECEPTION },
      requestId: null,
      ip: null,
      userAgent: null,
    };
    for (const c of DEMO_COMMUNICATION) {
      await this.use(UpdatePatientCommunicationUseCase).execute(
        ids[c.patientIndex],
        c.input,
        ctx,
      );
    }
    // DX-203: responsables de pago y avisos, como los vincularía recepción.
    for (const r of DEMO_RESPONSIBLES) {
      await this.use(CreateResponsiblePartyUseCase).execute(
        ids[r.patientIndex],
        {
          responsiblePatientId:
            r.responsiblePatientIndex !== undefined
              ? ids[r.responsiblePatientIndex]
              : undefined,
          ...r.contact,
          relationship: r.relationship,
          isPayer: r.isPayer,
          receivesNotices: r.receivesNotices,
        },
        receptionId,
      );
    }
    // DX-153: catálogo de pagadores y coberturas, como las cargaría recepción.
    // Idempotente: el pagador se busca por nombre y la cobertura por pagador.
    const existing = await this.use(ListPayersUseCase).execute({
      includeInactive: true,
    });
    const payerIds = new Map<string, string>();
    for (const payer of DEMO_PAYERS) {
      const found = existing.find((e) => e.name === payer.name);
      const id =
        found?.id ??
        (
          await this.use(CreatePayerUseCase).execute(
            { name: payer.name, type: payer.type },
            receptionId,
          )
        ).id;
      payerIds.set(payer.key, id);
    }
    for (const c of DEMO_COVERAGES) {
      const patientId = ids[c.patientIndex];
      const payerId = payerIds.get(c.payerKey) as string;
      const has = await this.use(ListPatientCoveragesUseCase).execute(
        patientId,
      );
      if (has.some((h) => h.payer.id === payerId)) continue;
      await this.use(CreatePatientCoverageUseCase).execute(
        patientId,
        {
          payerId,
          planName: c.planName,
          memberNumber: c.memberNumber,
          validFrom: c.validFrom,
          validTo: c.validTo,
          isPrimary: c.isPrimary,
        },
        receptionId,
      );
    }
    return ids;
  }

  private async createClinicalRecords(
    patientIds: string[],
    dentists: string[],
    catalog: Map<string, string>,
  ): Promise<void> {
    const entries: { id: string; patientId: string }[] = [];
    for (const e of DEMO_CLINICAL_ENTRIES) {
      const entry = await this.use(CreateClinicalEntryUseCase).execute(
        patientIds[e.patientIndex],
        {
          entryDate: daysAgoAt(this.now, e.daysAgo, 10 * 60),
          reason: e.reason,
          notes: e.notes,
          diagnoses: e.diagnoses?.map((d) => ({ ...d })),
        },
        dentists[e.dentistIndex],
      );
      entries.push(entry);
    }
    // DX-038: una corrección por adenda, como se haría en la clínica.
    for (const ad of DEMO_CLINICAL_ADDENDA) {
      const entry = entries[ad.entryIndex];
      await this.use(CreateClinicalEntryAddendumUseCase).execute(
        entry.patientId,
        entry.id,
        { reason: ad.reason, text: ad.text },
        dentists[ad.dentistIndex],
      );
    }
    const toothRecords: { id: string; patientId: string }[] = [];
    for (const r of DEMO_TOOTH_RECORDS) {
      const catalogItemId = catalogId(catalog, r.catalogCode);
      const record = await this.use(AddToothRecordUseCase).execute(
        patientIds[r.patientIndex],
        {
          toothNumber: r.toothNumber,
          surfaces: r.surfaces,
          kind: r.catalogCode.startsWith('DX-') ? 'DIAGNOSIS' : 'PROCEDURE',
          catalogItemId,
          status: r.status,
          notes: r.notes,
          recordedAt: daysAgoAt(this.now, r.daysAgo, 10 * 60 + 30),
        },
        dentists[r.dentistIndex],
      );
      toothRecords.push(record);
    }
    // DX-120: una anulación con motivo, hecha por el autor del registro.
    for (const v of DEMO_TOOTH_RECORD_VOIDS) {
      const record = toothRecords[v.recordIndex];
      await this.use(VoidToothRecordUseCase).execute(
        record.patientId,
        record.id,
        v.reason,
        { userId: dentists[v.dentistIndex], role: ClinicRole.DENTIST },
      );
    }
    // DX-120: dentición mixta de una paciente infantil, con registros
    // temporales y de otro origen.
    const kid = patientIds[DEMO_PEDIATRIC.patientIndex];
    const kidDentist = dentists[DEMO_PEDIATRIC.dentistIndex];
    for (const e of DEMO_PEDIATRIC.events) {
      await this.use(RecordDentitionEventsUseCase).execute(
        kid,
        {
          positions: [...e.positions],
          dentition: e.dentition,
          reason: e.reason,
        },
        kidDentist,
      );
    }
    for (const r of DEMO_PEDIATRIC.records) {
      await this.use(AddToothRecordUseCase).execute(
        kid,
        {
          toothNumber: r.toothNumber,
          surfaces: [...r.surfaces],
          kind: r.catalogCode.startsWith('DX-') ? 'DIAGNOSIS' : 'PROCEDURE',
          catalogItemId: catalogId(catalog, r.catalogCode),
          status: r.status,
          origin: r.origin,
          notes: 'notes' in r ? r.notes : undefined,
          recordedAt: daysAgoAt(this.now, r.daysAgo, 11 * 60),
        },
        kidDentist,
      );
    }
  }

  /**
   * DX-121: los tipos de cita de la demo (los crea el ADMIN, como en
   * /settings/tipos-de-cita). Devuelve motivo del calendario -> id del tipo.
   */
  private async createAppointmentTypes(
    ownerId: string,
  ): Promise<Map<string, string>> {
    const typeByReason = new Map<string, string>();
    for (const spec of DEMO_APPOINTMENT_TYPES) {
      const type = await this.use(CreateAppointmentTypeUseCase).execute(
        {
          name: spec.name,
          durationMinutes: spec.durationMinutes,
          color: spec.color,
        },
        ownerId,
      );
      for (const reason of spec.reasons) typeByReason.set(reason, type.id);
    }
    return typeByReason;
  }

  /**
   * DX-233: la segunda dentista rota entre las dos sedes (lun, mié y vie en
   * la principal; mar y jue en la Norte) y, el lunes que vuelve de
   * vacaciones, no va a la principal y cubre la Norte por la mañana. El ADMIN
   * lo guarda con los mismos casos de uso que /settings/horarios (auditado).
   */
  private async createProviderRotation(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    dentists: string[],
    ownerId: string,
  ): Promise<void> {
    const ctx: AuditRequestContext = {
      tenantId,
      locationId: null,
      actor: { userId: ownerId, role: ClinicRole.ADMIN },
      requestId: null,
      ip: null,
      userAgent: null,
    };
    const providerId = dentists[DEMO_ROTATION.dentistIndex];
    const keys: DemoLocationKey[] = ['principal', 'norte'];
    await this.use(ReplaceProviderScheduleUseCase).execute(
      providerId,
      {
        locations: keys.map((key) => ({
          locationId: locations[key],
          ranges: DEMO_ROTATION.weekdays[key].flatMap((weekday) =>
            DEMO_ROTATION.ranges[key].map((r) => ({ weekday, ...r })),
          ),
        })),
      },
      ctx,
    );
    const cover = civilDateIn(
      daysAgoAt(this.now, -daysUntilRotationCover(this.now), 12 * 60),
      DEMO_TIMEZONE,
    );
    const overrides = this.use(SetProviderOverrideUseCase);
    // Primero «no trabaja» en la principal: si no, la mañana de la Norte se
    // solaparía con su lunes en la principal.
    await overrides.execute(
      providerId,
      { locationId: locations.principal, date: cover, ranges: [] },
      ctx,
    );
    await overrides.execute(
      providerId,
      {
        locationId: locations.norte,
        date: cover,
        ranges: [...DEMO_ROTATION.cover.ranges],
        note: DEMO_ROTATION.cover.note,
      },
      ctx,
    );
  }

  private async createAppointments(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    hours: Record<DemoLocationKey, BusinessHours | null>,
    patientIds: string[],
    dentists: string[],
    createdById: string,
    typeByReason: Map<string, string>,
  ): Promise<AttendedAppointment[]> {
    // DX-040: el paciente de las opciones A/B no tiene cita futura (por eso
    // sale en «Presupuestos por seguir»); sus citas pasadas se quedan.
    const planned = planAppointments(
      this.now,
      patientIds.length,
      (key, start, end) => fitsBusinessHours(start, end, hours[key]),
    ).filter(
      (a) =>
        a.patientIndex !== DEMO_PLAN_OPTIONS.patientIndex ||
        a.end.getTime() <= this.now.getTime(),
    );
    const appointments = this.use(CreateAppointmentUseCase);
    const attended: AttendedAppointment[] = [];
    let cancelled = 0;

    for (const a of planned) {
      await this.inTenant(tenantId, locations[a.location], async () => {
        const input = {
          patientId: patientIds[a.patientIndex],
          providerId: dentists[a.dentistIndex],
          start: a.start,
          end: a.end,
          reason: a.reason,
          createdById,
          // DX-121: el hueco del calendario manda (end explícito); el tipo
          // solo colorea la tarjeta.
          appointmentTypeId: typeByReason.get(a.reason),
        };
        // Pasado/futuro se decide con el reloj VIVO (el mismo que usa el caso
        // de uso), no con `this.now`. Las pasadas van por la ruta histórica,
        // que conserva todas las validaciones salvo "no en el pasado".
        const isFuture = a.start.getTime() >= Date.now() + FUTURE_MARGIN_MS;
        const created = isFuture
          ? await appointments.execute(input)
          : await appointments.registerHistorical(input);
        if (a.status !== AppointmentStatus.SCHEDULED) {
          await this.use(UpdateAppointmentUseCase).execute(created.id, {
            status: a.status,
            // DX-279: cancelar exige origen y motivo; las del calendario las
            // avisó el paciente con 2 días (antes de que exista la política).
            ...(a.status === AppointmentStatus.CANCELLED
              ? {
                  cancellation: this.calendarCancellation(a.start, cancelled++),
                }
              : {}),
          });
        }
        if (a.status === AppointmentStatus.COMPLETED) {
          attended.push({
            id: created.id,
            patientId: created.patientId,
            providerId: created.providerId,
            start: created.start,
          });
        }
      });
    }
    return attended;
  }

  /** DX-279: cancelación del calendario, avisada por el paciente con 2 días. */
  private calendarCancellation(start: Date, n: number): CancellationRequest {
    const { calendarNoticeHours, calendarReasons } = DEMO_CANCELLATION;
    const at = new Date(
      Math.min(start.getTime() - calendarNoticeHours * 3_600_000, Date.now()),
    );
    return {
      byKind: 'STAFF_FOR_PATIENT',
      reasonCode: calendarReasons[n % calendarReasons.length],
      at,
    };
  }

  /**
   * DX-279: el ADMIN guarda la política de cancelación de la sede principal
   * (por el mismo caso de uso que la API) y una paciente acumula dos
   * inasistencias y una cancelación tardía en citas pasadas de esa sede, para
   * ver la insignia en su ficha y en sus citas. DX-291: esas tres citas
   * tienen la política comunicada (como si la hubiera llevado el
   * recordatorio) y se pueden cobrar. Otra inasistencia, de otro paciente y
   * también con la política comunicada, se puede cobrar igual (DX-321).
   */
  private async createCancellationPolicy(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    hours: Record<DemoLocationKey, BusinessHours | null>,
    patientIds: string[],
    dentists: string[],
    ownerId: string,
  ): Promise<void> {
    const { location, policy, incidents } = DEMO_CANCELLATION;
    const locationId = locations[location];
    const version = await this.inTenant(tenantId, locationId, () =>
      this.use(CreateCancellationPolicyVersionUseCase).execute(
        locationId,
        { ...policy },
        ownerId,
      ),
    );
    // El primer hueco libre (horario de la sede, sin solape del profesional
    // ni de la paciente) desde `daysAgo` hacia atrás, dentro de la semana
    // pasada del calendario: la demo no tiene citas de hace más de 15 días.
    const book = async (
      daysAgo: number,
      patientIndex: number = incidents.patientIndex,
    ) => {
      for (let d = daysAgo; d <= incidents.lastDaysAgo; d++) {
        for (let m = incidents.firstMinute; m < incidents.lastMinute; m += 30) {
          const start = daysAgoAt(this.now, d, m);
          const end = new Date(start.getTime() + 30 * 60_000);
          if (!fitsBusinessHours(start, end, hours[location])) continue;
          try {
            return await this.use(CreateAppointmentUseCase).registerHistorical({
              patientId: patientIds[patientIndex],
              providerId: dentists[incidents.dentistIndex],
              start,
              end,
              reason: 'Control',
              createdById: ownerId,
            });
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
          }
        }
      }
      throw new Error(
        `Sin hueco en la sede ${location} desde hace ${daysAgo} días`,
      );
    };
    const incidentIds = await this.inTenant(tenantId, locationId, async () => {
      const update = this.use(UpdateAppointmentUseCase);
      const ids: string[] = [];
      for (const daysAgo of incidents.noShowDaysAgo) {
        const a = await book(daysAgo);
        await update.execute(a.id, { status: AppointmentStatus.NO_SHOW });
        ids.push(a.id);
      }
      const late = incidents.lateCancellation;
      const a = await book(late.daysAgo);
      await update.execute(a.id, {
        status: AppointmentStatus.CANCELLED,
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: late.reasonCode,
          at: new Date(a.start.getTime() - late.hoursBefore * 3_600_000),
        },
      });
      ids.push(a.id);
      const { chargeable } = incidents;
      const noShow = await book(
        chargeable.noShowDaysAgo,
        chargeable.patientIndex,
      );
      await update.execute(noShow.id, { status: AppointmentStatus.NO_SHOW });
      ids.push(noShow.id);
      return ids;
    });
    await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.appointment.updateMany({
        where: { id: { in: incidentIds } },
        data: { policyVersionId: version.id },
      }),
    );
  }

  /**
   * DX-170: el ADMIN carga las plantillas de ejemplo (como el botón de
   * Ajustes) y los odontólogos redactan con ellas la evolución de las últimas
   * citas atendidas, ligada a la cita, por el mismo caso de uso que la API.
   */
  private async createTemplateEvolutions(
    ownerId: string,
    attended: AttendedAppointment[],
  ): Promise<void> {
    const templates = await this.use(LoadSampleNoteTemplatesUseCase).execute(
      ownerId,
    );
    const latest = [...attended]
      .filter((a) => a.start.getTime() <= this.now.getTime())
      .sort((x, y) => y.start.getTime() - x.start.getTime());
    for (const [i, evolution] of DEMO_TEMPLATE_EVOLUTIONS.entries()) {
      const appointment = latest[i];
      const template = templates.find((t) => t.name === evolution.template);
      if (!appointment || !template) continue;
      await this.use(CreateClinicalEntryUseCase).execute(
        appointment.patientId,
        {
          appointmentId: appointment.id,
          templateId: template.id,
          reason: template.name,
          answers: template.prompts
            .filter((p) => p.label in evolution.answers)
            .map((p) => ({
              promptId: p.id,
              values: [...evolution.answers[p.label]],
            })),
        },
        appointment.providerId,
      );
    }
  }

  /**
   * DX-307: el ADMIN carga los anestésicos sugeridos (como el botón de
   * Ajustes) y la primera dentista registra en una evolución de la paciente
   * infantil la anestesia de una exodoncia, por los mismos casos de uso que la
   * API (dosis calculada con el peso de la anamnesis).
   */
  private async createAnesthesia(
    ownerId: string,
    patientIds: string[],
    dentistId: string,
  ): Promise<void> {
    const products = await this.use(AnestheticCatalogUseCases).loadSamples(
      ownerId,
    );
    const product = products.find(
      (p) => p.sampleCode === DEMO_ANESTHESIA.sampleCode,
    );
    const patientId = patientIds[DEMO_ANESTHESIA.patientIndex];
    if (!product || !patientId) return;
    const entry = await this.use(CreateClinicalEntryUseCase).execute(
      patientId,
      { reason: DEMO_ANESTHESIA.reason, notes: DEMO_ANESTHESIA.notes },
      dentistId,
    );
    await this.use(AnesthesiaUseCases).record(
      patientId,
      entry.id,
      {
        anestheticId: product.id,
        carpules: DEMO_ANESTHESIA.carpules,
        technique: DEMO_ANESTHESIA.technique,
        site: DEMO_ANESTHESIA.site,
        lot: DEMO_ANESTHESIA.lot,
      },
      dentistId,
    );
  }

  /**
   * DX-407: una hoja de sedación completa (valoración → checklist → N2O →
   * constantes → egreso) en una evolución nueva de la paciente infantil, por
   * los mismos casos de uso que la API: la dentista seda y firma el egreso;
   * el asistente toma las constantes y monitoriza.
   */
  private async createSedation(
    patientIds: string[],
    dentistId: string,
    assistantId: string,
  ): Promise<void> {
    const patientId = patientIds[DEMO_SEDATION.patientIndex];
    if (!patientId || !assistantId) return;
    const minutesAgo = (m: number) => new Date(this.now.getTime() - m * 60_000);
    const entry = await this.use(CreateClinicalEntryUseCase).execute(
      patientId,
      { reason: DEMO_SEDATION.reason, notes: DEMO_SEDATION.notes },
      dentistId,
    );
    const sedation = this.use(SedationUseCases);
    await sedation.assess(
      patientId,
      entry.id,
      {
        ...DEMO_SEDATION.assessment,
        assessedAt: minutesAgo(DEMO_SEDATION.assessedMinutesAgo),
      },
      dentistId,
    );
    await sedation.addVitals(
      patientId,
      entry.id,
      {
        phase: 'BASELINE',
        takenAt: minutesAgo(DEMO_SEDATION.baselineMinutesAgo),
        ...DEMO_SEDATION.vitals,
        sedationLevel: 'AWAKE',
      },
      assistantId,
    );
    await sedation.check(
      patientId,
      entry.id,
      PLATFORM_SEDATION_TEMPLATE.checklist.map((i) => ({
        code: i.code,
        checked: true,
      })),
      dentistId,
      minutesAgo(DEMO_SEDATION.checkedMinutesAgo),
    );
    await sedation.addAgent(
      patientId,
      entry.id,
      {
        kind: 'NITROUS_OXIDE',
        n2oPercent: DEMO_SEDATION.n2o.n2oPercent,
        flowLpm: DEMO_SEDATION.n2o.flowLpm,
        administeredAt: minutesAgo(DEMO_SEDATION.n2o.minutesAgo),
      },
      dentistId,
    );
    for (const m of DEMO_SEDATION.intraMinutesAgo) {
      await sedation.addVitals(
        patientId,
        entry.id,
        {
          phase: 'INTRA',
          takenAt: minutesAgo(m),
          ...DEMO_SEDATION.vitals,
          sedationLevel: 'MINIMAL',
        },
        assistantId,
      );
    }
    await sedation.discharge(
      patientId,
      entry.id,
      {
        criteria: PLATFORM_SEDATION_TEMPLATE.dischargeCriteria.map((c) => ({
          code: c.code,
          met: true,
        })),
        vitals: { ...DEMO_SEDATION.vitals, sedationLevel: 'AWAKE' },
        dischargedAt: minutesAgo(DEMO_SEDATION.dischargeMinutesAgo),
        handedOverToName: DEMO_SEDATION.assessment.escortName,
        handedOverToRelationship: DEMO_SEDATION.assessment.escortRelationship,
        instructionsDelivered: true,
        monitorId: assistantId,
      },
      dentistId,
    );
  }

  /**
   * DX-222: el ADMIN carga las indicaciones postoperatorias de ejemplo (como el
   * botón de Ajustes) y las vincula a procedimientos y tipos de cita; el
   * odontólogo de la última cita atendida de un día anterior entrega impresas
   * las de `DEMO_POSTOP.delivered`, por el mismo caso de uso que la API (texto
   * congelado y auditado).
   */
  private async createPostOpInstructions(
    tenantId: string,
    ownerId: string,
    catalog: Map<string, string>,
    typeByReason: Map<string, string>,
    attended: AttendedAppointment[],
  ): Promise<void> {
    await this.use(LoadSamplePostOpTemplatesUseCase).execute(ownerId);
    const templates = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.postOpInstructionTemplate.findMany({
        select: { id: true, code: true },
      }),
    );
    const idByCode = new Map(templates.map((t) => [t.code, t.id]));
    const typeByName = new Map(
      DEMO_APPOINTMENT_TYPES.map((t) => [
        t.name,
        typeByReason.get(t.reasons[0]),
      ]),
    );
    const lookup = (map: Map<string, string | undefined>, key: string) => {
      const id = map.get(key);
      if (!id) throw new Error(`Demo DX-222: no existe «${key}».`);
      return id;
    };
    for (const link of DEMO_POSTOP.links) {
      await this.use(UpdatePostOpTemplateUseCase).execute(
        lookup(idByCode, link.code),
        {
          catalogItemIds: link.catalogCodes.map((c) => lookup(catalog, c)),
          appointmentTypeIds: link.appointmentTypes.map((n) =>
            lookup(typeByName, n),
          ),
        },
        ownerId,
      );
    }

    const todayStart = daysAgoAt(this.now, 0, 0).getTime();
    const appointment = [...attended]
      .filter((a) => a.start.getTime() < todayStart)
      .sort((x, y) => y.start.getTime() - x.start.getTime())[0];
    if (!appointment) return;
    await this.use(DeliverPostOpInstructionsUseCase).execute(
      appointment.id,
      {
        templateId: lookup(idByCode, DEMO_POSTOP.delivered),
        channel: 'PRINT',
      },
      {
        tenantId,
        locationId: null,
        actor: { userId: appointment.providerId, role: ClinicRole.DENTIST },
        requestId: null,
        ip: null,
        userAgent: null,
      },
      // Impreso: sin enlace, no hace falta host.
      { protocol: 'http', host: null },
    );
  }

  /**
   * DX-099: recepción envía el enlace de anamnesis a una paciente y ella lo
   * responde, por los mismos casos de uso que la API (enlace con su hash,
   * autorización vigente, envío auditado sin respuestas). Queda SUBMITTED en
   * la sede principal: el doctor la ve en «Anamnesis por revisar» al entrar.
   * El evento de crear el enlace es el que escribe el `@Audit` de la ruta.
   */
  private async createAnamnesisSubmission(
    tenantId: string,
    patientIds: string[],
    receptionId: string,
  ): Promise<void> {
    const patientId = patientIds[DEMO_ANAMNESIS_SUBMISSION.patientIndex];
    const created = await this.use(CreateAnamnesisRequestUseCase).execute(
      patientId,
      {},
      receptionId,
      { protocol: 'http', host: 'demo.localhost:3001' },
    );
    await this.use(RecordAuditEventUseCase).record({
      tenantId,
      locationId: null,
      actor: { kind: 'user', userId: receptionId, role: ClinicRole.RECEPTION },
      action: 'CREATE',
      resourceType: 'MEDICAL_HISTORY_SUBMISSION',
      resourceId: created.id,
      patient: { kind: 'patient', id: patientId },
      requestId: null,
      ip: null,
      userAgent: null,
      metadata: { reason: 'ANAMNESIS_LINK_CREATED' },
    });
    const token = created.url.split('/').at(-1);
    if (!token) throw new Error('Demo DX-099: el enlace no trae token.');
    await this.use(SubmitPublicAnamnesisUseCase).execute(
      token,
      { answers: DEMO_ANAMNESIS_SUBMISSION.answers, declarationAccepted: true },
      { ipAddress: null, userAgent: null, requestId: null },
    );
  }

  /**
   * DX-122: un bloqueo de vacaciones y uno de almuerzo, y «Pendientes por
   * agendar» con 3 abiertos. Recepción lo hace por los mismos casos de uso que
   * la API (validaciones, auditoría). Las cancelaciones y no-shows del
   * calendario ya crearon sus entradas al cambiar de estado.
   */
  private async createScheduleBlocksAndWaitlist(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    dentists: string[],
    receptionId: string,
  ): Promise<void> {
    const actor = { userId: receptionId, role: ClinicRole.RECEPTION };
    const ctx: AuditRequestContext = {
      tenantId,
      locationId: null,
      actor,
      requestId: null,
      ip: null,
      userAgent: null,
    };
    await this.inTenant(tenantId, undefined, async () => {
      const blocks = this.use(CreateScheduleBlockUseCase);
      const monday = daysUntilMondayAfterNext(this.now);
      await blocks.execute(
        {
          providerId: dentists[DEMO_VACATION.dentistIndex],
          start: daysAgoAt(this.now, -monday, 0),
          end: daysAgoAt(this.now, -(monday + 5), 0),
          kind: ScheduleBlockKind.VACATION,
          note: DEMO_VACATION.note,
        },
        actor,
      );
      const day = daysUntilNextWeekday(this.now);
      await blocks.execute(
        {
          locationId: locations.principal,
          start: daysAgoAt(this.now, -day, DEMO_LUNCH.startMinute),
          end: daysAgoAt(this.now, -day, DEMO_LUNCH.endMinute),
          kind: ScheduleBlockKind.LUNCH,
          allowsBooking: true,
          note: DEMO_LUNCH.note,
          // Deja agendar: las citas que caigan dentro se quedan, con aviso.
          confirmAffected: true,
        },
        actor,
      );

      const open = await this.use(ListWaitlistUseCase).execute({
        pageSize: 50,
      });
      // Se quedan abiertas las `keepOpen` más recientes de pacientes
      // DISTINTOS (un paciente no sale dos veces en la lista); el resto se
      // descarta con motivo, como historial.
      const keep: typeof open.items = [];
      for (const entry of [...open.items].reverse()) {
        if (keep.length === DEMO_WAITLIST.keepOpen) break;
        if (!keep.some((k) => k.patientId === entry.patientId))
          keep.push(entry);
      }
      const dismiss = this.use(DismissWaitlistEntryUseCase);
      for (const entry of open.items.filter((e) => !keep.includes(e))) {
        await dismiss.execute(entry.id, DEMO_WAITLIST.dismissReason, ctx);
      }
      // El alta manual: el primer paciente de la lista candidata que no esté ya.
      const manual = DEMO_WAITLIST.manual;
      const pending = new Set(keep.map((k) => k.patientId));
      const manualPatientId = [manual.patientIndex, ...patientIds.keys()]
        .map((i) => patientIds[i])
        .find((id) => !pending.has(id))!;
      await this.use(CreateWaitlistEntryUseCase).execute(
        {
          patientId: manualPatientId,
          locationId: locations.principal,
          providerId: dentists[manual.dentistIndex],
          priority: WaitlistPriority.URGENT,
          preferredWindow: manual.preferredWindow,
          note: manual.note,
        },
        ctx,
      );

      // DX-210: la cita agendada más lejana de la primera dentista en la sede
      // principal queda marcada «Adelantar si hay hueco»: sale como candidata
      // al cancelar una cita de un día anterior («Ocupar este hueco»).
      const upcoming = await this.use(ListAppointmentsUseCase).execute({
        from: daysAgoAt(this.now, -2, 0),
        to: daysAgoAt(this.now, -21, 0),
        providerId: dentists[0],
        locationId: locations.principal,
      });
      const farthest = upcoming
        .filter((a) => a.status === AppointmentStatus.SCHEDULED)
        .at(-1);
      if (farthest) {
        await this.use(UpdateAppointmentUseCase).execute(
          farthest.id,
          { wantsEarlier: true },
          ctx,
        );
      }
    });
  }

  /**
   * DX-247: anamnesis de hace más de un año, para ver «Anamnesis caducada» en
   * la agenda y en la ficha. La historia es inalterable (no se puede antedatar
   * una versión ya guardada), así que la versión 1 se inserta ya con su fecha,
   * con las banderas derivadas en el dominio como en el alta. Al que la
   * dentista revisó hoy, «Sin cambios hoy» por el mismo caso de uso que la API
   * y su evento de auditoría (lo que escribe el `@Audit` de la ruta).
   */
  private async createBackdatedAnamneses(
    tenantId: string,
    patientIds: string[],
    dentistId: string,
  ): Promise<void> {
    for (const b of DEMO_MEDICAL_ALERTS.backdated) {
      const patientId = patientIds[b.patientIndex];
      const data: MedicalHistoryVersionData =
        DEMO_PATIENTS[b.patientIndex].medicalHistory ?? {};
      const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags(data);
      await this.prisma.runWithTenant((tx) =>
        tx.medicalHistoryVersion.create({
          data: {
            tenantId,
            patientId,
            version: 1,
            allergies: (data.allergies ??
              []) as unknown as Prisma.InputJsonValue,
            conditions: (data.conditions ??
              []) as unknown as Prisma.InputJsonValue,
            medications: (data.medications ??
              []) as unknown as Prisma.InputJsonValue,
            habits: (data.habits ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            safetyFlags: safetyFlags as unknown as Prisma.InputJsonValue,
            hasCriticalAlert,
            createdById: dentistId,
            createdAt: monthsBefore(this.now, b.monthsAgo),
          },
        }),
      );
      if (!b.confirmNoChanges) continue;
      const confirmation = await this.use(
        ConfirmAnamnesisNoChangesUseCase,
      ).execute(patientId, dentistId);
      await this.use(RecordAuditEventUseCase).record({
        tenantId,
        locationId: null,
        actor: { kind: 'user', userId: dentistId, role: ClinicRole.DENTIST },
        action: 'UPDATE',
        resourceType: 'MEDICAL_HISTORY',
        resourceId: confirmation.id,
        patient: { kind: 'patient', id: patientId },
        requestId: null,
        ip: null,
        userAgent: null,
        metadata: { reason: 'NO_CHANGES_CONFIRMED' },
      });
    }
  }

  /**
   * DX-200: el panel «En clínica» de la sede principal con gente HOY: dos en
   * espera (una llegó antes de su hora, otra 3 min tarde), una en el sillón y
   * otra lista para cobrar, de la primera dentista (o de la segunda si la
   * primera está ocupada a esa hora). Recepción marca la llegada y la
   * dentista el resto, por el mismo caso de uso que la API (con auditoría).
   * Mejor esfuerzo: un hueco sin profesional o paciente libre se salta; hoy
   * cerrado, no hay nadie.
   */
  private async createInClinicToday(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    hours: Record<DemoLocationKey, BusinessHours | null>,
    patientIds: string[],
    dentists: string[],
    receptionId: string,
  ): Promise<void> {
    const slots = planInClinicToday(this.now, hours.principal?.ranges ?? []);
    const ctx = (userId: string, role: ClinicRole): AuditRequestContext => ({
      tenantId,
      locationId: locations.principal,
      actor: { userId, role },
      requestId: null,
      ip: null,
      userAgent: null,
    });
    // Sin la paciente de las opciones A/B: no tiene cita futura (DX-040).
    // DX-247: el paciente que requiere premedicación entra primero, para ver
    // su alerta en el panel.
    const premedicated =
      patientIds[DEMO_MEDICAL_ALERTS.premedicationPatientIndex];
    const candidates = [
      premedicated,
      ...patientIds.filter(
        (id, i) => i !== DEMO_PLAN_OPTIONS.patientIndex && id !== premedicated,
      ),
    ];
    const used = new Set<string>();
    await this.inTenant(tenantId, locations.principal, async () => {
      const create = this.use(CreateAppointmentUseCase);
      const update = this.use(UpdateAppointmentUseCase);
      for (const slot of slots) {
        const booked = await this.bookFirstFree(
          create,
          slot,
          dentists,
          candidates,
          used,
          receptionId,
        );
        if (!booked) continue;
        used.add(booked.patientId);
        await update.execute(
          booked.id,
          { status: AppointmentStatus.ARRIVED },
          ctx(receptionId, ClinicRole.RECEPTION),
        );
        const dentist = ctx(booked.providerId, ClinicRole.DENTIST);
        if (slot.stage !== 'ARRIVED') {
          await update.execute(
            booked.id,
            { status: AppointmentStatus.IN_CHAIR },
            dentist,
          );
        }
        if (slot.stage === 'READY_FOR_CHECKOUT') {
          await update.execute(
            booked.id,
            { status: AppointmentStatus.READY_FOR_CHECKOUT },
            dentist,
          );
        }
      }
    });
  }

  /** La primera combinación profesional × paciente libre a esa hora, o null. */
  private async bookFirstFree(
    create: CreateAppointmentUseCase,
    slot: { start: Date; end: Date },
    dentists: string[],
    patientIds: string[],
    used: Set<string>,
    createdById: string,
  ): Promise<{ id: string; patientId: string; providerId: string } | null> {
    const isFuture = slot.start.getTime() >= Date.now() + FUTURE_MARGIN_MS;
    for (const providerId of dentists) {
      for (const patientId of patientIds) {
        if (used.has(patientId)) continue;
        const input = {
          patientId,
          providerId,
          start: slot.start,
          end: slot.end,
          reason: 'Control',
          createdById,
        };
        try {
          const created = isFuture
            ? await create.execute(input)
            : await create.registerHistorical(input);
          return { id: created.id, patientId, providerId };
        } catch (error) {
          // El paciente ya tiene cita a esa hora: el siguiente. El profesional
          // (cita o bloqueo): el otro profesional.
          if (!(error instanceof ConflictException)) throw error;
          if (error.message !== OVERLAP_MESSAGES.patient) break;
        }
      }
    }
    return null;
  }

  /**
   * DX-050: un realizado de la demo se fecha el día del primer abono del plan
   * (ningún caso de uso fecha el pasado); uno `unattributed` queda como los
   * DONE anteriores a DX-050, sin quién, sede ni fecha. Bajo
   * `app.current_tenant`, como el resto.
   */
  private async datePlanItemDone(
    itemId: string,
    spec: DemoPlan,
    item: DemoPlanItem,
  ): Promise<void> {
    const firstPaymentDaysAgo = Math.max(
      0,
      ...spec.payments.map((p) => p.daysAgo),
    );
    const data = item.unattributed
      ? {
          performedById: null,
          performedByMembershipId: null,
          performedLocationId: null,
          completedAt: null,
        }
      : { completedAt: daysAgoAt(this.now, firstPaymentDaysAgo, 10 * 60) };
    await this.prisma.runWithTenant((tx) =>
      tx.treatmentPlanItem.update({ where: { id: itemId }, data }),
    );
  }

  /**
   * DX-014: un día con actividad en cada sede en el mes anterior y en el
   * actual (`planComparisonHistory`), para que «Comparar sedes» compare algo
   * cualquier día del mes. Cada visita es una cita atendida (ruta histórica,
   * con las validaciones de horario y solapes), un plan con su procedimiento
   * realizado allí por la dentista (DX-050, fechado a la hora de la cita) y el
   * abono del total en la sede al terminar. Sin caja: va antes de los turnos
   * de hoy, como el resto de abonos históricos.
   */
  private async createComparisonHistory(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    dentists: string[],
    receptionId: string,
    catalog: Map<string, string>,
  ): Promise<void> {
    const dentistId = dentists[DEMO_COMPARISON_HISTORY.dentistIndex];
    const dentist = { userId: dentistId, role: ClinicRole.DENTIST };
    for (const visit of planComparisonHistory(
      this.now,
      DEMO_COMPARISON_HISTORY,
    )) {
      const start = daysAgoAt(this.now, visit.daysAgo, visit.startMinute);
      const end = daysAgoAt(
        this.now,
        visit.daysAgo,
        visit.startMinute + visit.durationMinutes,
      );
      const patientId = patientIds[visit.patientIndex];
      await this.inTenant(tenantId, locations[visit.location], async () => {
        const appointment = await this.use(
          CreateAppointmentUseCase,
        ).registerHistorical({
          patientId,
          providerId: dentistId,
          start,
          end,
          reason: DEMO_COMPARISON_HISTORY.reason,
          createdById: receptionId,
        });
        await this.use(UpdateAppointmentUseCase).execute(appointment.id, {
          status: AppointmentStatus.COMPLETED,
        });
        const plan = await this.use(CreateTreatmentPlanUseCase).execute({
          patientId,
          currency: DEMO_CURRENCY,
          notes: 'Control y procedimiento del día.',
          createdById: dentistId,
        });
        const item = await this.use(AddTreatmentPlanItemUseCase).execute(
          plan.id,
          {
            toothNumber: '16',
            catalogItemId: catalogId(catalog, visit.procedure),
          },
          dentist,
        );
        await this.use(UpdateTreatmentPlanItemUseCase).execute(
          item.id,
          { status: TreatmentPlanItemStatus.DONE },
          dentist,
        );
        await this.prisma.runWithTenant((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: item.id },
            data: { completedAt: start },
          }),
        );
        for (const status of [
          TreatmentPlanStatus.ACCEPTED,
          TreatmentPlanStatus.COMPLETED,
        ]) {
          await this.use(UpdateTreatmentPlanUseCase).execute(
            plan.id,
            { status },
            { role: ClinicRole.DENTIST },
          );
        }
        await this.use(RecordPaymentUseCase).execute(
          plan.id,
          {
            amount: Number(item.price) - Number(item.discount),
            currency: DEMO_CURRENCY,
            paidAt: new Date(end.getTime() + 10 * 60 * 1000),
            method: PaymentMethod.CARD,
          },
          receptionId,
        );
      });
    }
  }

  /**
   * DX-051: el seed llama a los casos de uso fuera de HTTP, sin el interceptor
   * que drena la cola; aquí se reparte lo cobrado y un ADMIN fija un abono a
   * mano (el plan de la rehabilitación del 36), para que la demo enseñe
   * imputaciones automáticas, una fijada y un plan con importe sin imputar.
   */
  private async allocatePayments(
    tenantId: string,
    ownerId: string,
  ): Promise<void> {
    await this.inTenant(tenantId, undefined, async () => {
      await this.use(PlanAllocationRebalancer).drainPending({ actorId: null });
      const pinned = await this.prisma.runWithTenant((tx) =>
        tx.payment.findFirstOrThrow({
          where: {
            deletedAt: null,
            plan: { notes: DEMO_PLANS[0].notes },
          },
          orderBy: { paidAt: 'desc' },
          select: { id: true },
        }),
      );
      const current = await this.use(GetPaymentAllocationsUseCase).execute(
        pinned.id,
      );
      await this.use(ReplacePaymentAllocationsUseCase).execute(
        pinned.id,
        {
          mode: 'MANUAL',
          expectedVersion: current.version,
          allocations: current.allocations.map(
            ({ treatmentPlanItemId, amount }) => ({
              treatmentPlanItemId,
              amount,
            }),
          ),
        },
        ownerId,
      );
    });
  }

  private async createPlansAndPayments(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    dentists: string[],
    receptionId: string,
    catalog: Map<string, string>,
    ownerId: string,
  ): Promise<void> {
    for (const spec of DEMO_PLANS) {
      const dentistId = dentists[spec.dentistIndex];
      const planId = await this.inTenant(tenantId, undefined, async () => {
        const plan = await this.use(CreateTreatmentPlanUseCase).execute({
          patientId: patientIds[spec.patientIndex],
          currency: DEMO_CURRENCY,
          notes: spec.notes,
          createdById: dentistId,
        });
        const dentist = { userId: dentistId, role: ClinicRole.DENTIST };
        const owner = { userId: ownerId, role: ClinicRole.ADMIN };
        for (const item of spec.items) {
          // Sin `price`: el caso de uso toma la tarifa del catálogo. El
          // descuento pasa por la política de la clínica (DX-204) con el rol
          // de quien lo da.
          const added = await this.use(AddTreatmentPlanItemUseCase).execute(
            plan.id,
            {
              toothNumber: item.tooth,
              surfaces: item.surfaces,
              catalogItemId: catalogId(catalog, item.code),
              discount: item.discount,
              discountReason: item.discountReason,
            },
            item.discountBy === 'owner' ? owner : dentist,
          );
          if (item.status !== 'PROPOSED') {
            // DONE refleja el ítem en el odontograma (lo hace el caso de uso)
            // y lo atribuye al odontólogo, en la sede del plan (DX-050).
            await this.inTenant(
              tenantId,
              locations[spec.doneAt ?? 'principal'],
              () =>
                this.use(UpdateTreatmentPlanItemUseCase).execute(
                  added.id,
                  { status: item.status },
                  dentist,
                ),
            );
            if (item.status === TreatmentPlanItemStatus.DONE) {
              await this.datePlanItemDone(added.id, spec, item);
            }
          }
        }
        // La máquina de estados (DX-040) no salta de borrador a completado:
        // un plan completado se aceptó antes.
        const path =
          spec.status === TreatmentPlanStatus.COMPLETED
            ? [TreatmentPlanStatus.ACCEPTED, TreatmentPlanStatus.COMPLETED]
            : spec.status === TreatmentPlanStatus.DRAFT
              ? []
              : [spec.status];
        for (const status of path) {
          await this.use(UpdateTreatmentPlanUseCase).execute(
            plan.id,
            { status },
            { role: ClinicRole.DENTIST },
          );
        }
        if (spec.openedDaysAgo !== undefined) {
          // DX-145: el plan se abrió hace N días (ningún caso de uso fecha un
          // plan en el pasado). Bajo `app.current_tenant`, como el resto.
          const openedAt = daysAgoAt(this.now, spec.openedDaysAgo, 9 * 60);
          await this.prisma.runWithTenant((tx) =>
            tx.treatmentPlan.update({
              where: { id: plan.id },
              data: { createdAt: openedAt },
            }),
          );
        }
        if (spec.paymentPlan) {
          await this.use(CreatePaymentPlanUseCase).execute(
            plan.id,
            {
              downPayment: spec.paymentPlan.downPayment,
              installmentsCount: spec.paymentPlan.installmentsCount,
              periodicity: 'MONTHLY',
              startDate: daysAgoAt(
                this.now,
                spec.paymentPlan.startDaysAgo,
                12 * 60,
              ),
              notes: 'Financiación acordada con el paciente.',
            },
            receptionId,
          );
        }
        return plan.id;
      });

      if (spec.signedAcceptance) {
        await this.acceptWithSignature(
          tenantId,
          locations.principal,
          patientIds[spec.patientIndex],
          planId,
          dentistId,
        );
      }

      for (const [i, payment] of spec.payments.entries()) {
        // DX-377: con referencia, por el medio demo «Pago móvil».
        const mobile = payment.mobileReference
          ? {
              paymentMethodId: await this.mobilePaymentMethod(
                tenantId,
                ownerId,
              ),
              reference: payment.mobileReference,
            }
          : {};
        await this.inTenant(tenantId, locations[payment.location], () =>
          this.use(RecordPaymentUseCase).execute(
            planId,
            {
              ...mobile,
              amount: payment.amount,
              currency: payment.currency ?? DEMO_CURRENCY,
              paidAt:
                payment.minutesAgo === undefined
                  ? daysAgoAt(this.now, payment.daysAgo, 11 * 60 + i * 20)
                  : new Date(this.now.getTime() - payment.minutesAgo * 60_000),
              method: payment.method,
              notes: payment.notes,
            },
            receptionId,
          ),
        );
      }

      // SEC-013: el plan financiado enseña además un abono anulado con autor y
      // motivo (un cobro registrado dos veces que la administradora anuló), para
      // ver «Anulado por …: motivo» en el estado de cuenta demo.
      const [first] = spec.payments;
      if (spec.paymentPlan && first) {
        await this.inTenant(tenantId, locations[first.location], async () => {
          const duplicate = await this.use(RecordPaymentUseCase).execute(
            planId,
            {
              amount: first.amount,
              currency: DEMO_CURRENCY,
              paidAt: daysAgoAt(this.now, first.daysAgo, 11 * 60 + 5),
              method: first.method,
            },
            receptionId,
          );
          await this.use(VoidPaymentUseCase).execute({
            paymentId: duplicate.id,
            reason:
              'Cobro registrado dos veces: el paciente pagó una sola vez.',
            actor: { userId: ownerId, role: ClinicRole.ADMIN },
          });
        });
      }
    }
  }

  /**
   * DX-027: la caja por turno de recepción en la sede principal, por los
   * mismos casos de uso que la API: el turno de la mañana, cerrado con una
   * diferencia de 2.000 en efectivo explicada, y el de la tarde abierto con su
   * fondo y un cobro. Va DESPUÉS de los abonos históricos, que quedan sin caja
   * (como los de antes de DX-027). Los ajustes de caja de la clínica quedan
   * como por defecto (sin «exigir caja abierta» ni «arqueo ciego»).
   */
  private async createCashSessions(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    receptionId: string,
  ): Promise<void> {
    const actor = { userId: receptionId, isAdmin: false };
    await this.inTenant(tenantId, locations.principal, async () => {
      // El plan aceptado con más saldo pendiente: los cobros del turno nunca
      // dejan un plan pagado de más.
      const plans = await this.prisma.runWithTenant((tx) =>
        tx.treatmentPlan.findMany({
          where: { status: TreatmentPlanStatus.ACCEPTED, deletedAt: null },
          select: {
            id: true,
            items: { select: { price: true, discount: true, status: true } },
            payments: {
              where: { deletedAt: null },
              select: { amount: true },
            },
          },
        }),
      );
      const pending = (p: (typeof plans)[number]) =>
        p.items
          .filter((i) => i.status !== 'PROPOSED')
          .reduce(
            (sum, i) => sum + i.price.toNumber() - i.discount.toNumber(),
            0,
          ) - p.payments.reduce((sum, pay) => sum + pay.amount.toNumber(), 0);
      const plan = [...plans].sort((a, b) => pending(b) - pending(a))[0];
      if (!plan || pending(plan) < 80_000) {
        throw new Error(
          'La demo no tiene un plan aceptado con saldo para la caja',
        );
      }
      const charge = (amount: number, method: 'CASH' | 'CARD') =>
        this.use(RecordPaymentUseCase).execute(
          plan.id,
          {
            amount,
            currency: DEMO_CURRENCY,
            paidAt: this.now,
            method,
            notes: 'Cobro en caja (turno demo).',
          },
          receptionId,
        );

      const morning = await this.use(OpenCashSessionUseCase).execute(
        {
          floats: [{ currency: DEMO_CURRENCY, amount: 200_000 }],
          notes: 'Turno de mañana',
        },
        actor,
      );
      await charge(40_000, 'CASH');
      await charge(25_000, 'CARD');
      await this.use(CloseCashSessionUseCase).execute(
        morning.id,
        {
          counts: [
            { currency: DEMO_CURRENCY, method: 'CASH', counted: 238_000 },
            { currency: DEMO_CURRENCY, method: 'CARD', counted: 25_000 },
          ],
          differenceReason: 'Se entregó cambio de más a un paciente.',
        },
        actor,
      );

      await this.use(OpenCashSessionUseCase).execute(
        {
          floats: [{ currency: DEMO_CURRENCY, amount: 150_000 }],
          notes: 'Turno de tarde',
        },
        actor,
      );
      await charge(15_000, 'CASH');
    });
  }

  /**
   * DX-274: tres gastos de la sede principal (pagado, parcial vencido y
   * pendiente) por los mismos casos de uso que la API, y una salida de caja
   * menor de recepción en el turno ABIERTO de la tarde. Va DESPUÉS de las
   * cajas y no toca la cerrada de la mañana, así que su arqueo sigue
   * cuadrando; los pagos de los gastos son por transferencia, fuera de caja.
   */
  private async createExpenses(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    ownerId: string,
    receptionId: string,
  ): Promise<void> {
    const today = civilDateIn(this.now, DEMO_TIMEZONE);
    const day = (offset: number) => addCivilDays(today, offset);
    await this.inTenant(tenantId, locations.principal, async () => {
      for (const expense of DEMO_EXPENSES) {
        await this.use(CreateExpenseUseCase).execute(
          {
            locationId: locations.principal,
            category: expense.category,
            supplier: expense.supplier,
            description: expense.description,
            amount: expense.amount,
            currency: DEMO_CURRENCY,
            invoiceDate: day(expense.invoice),
            dueDate: expense.due === null ? null : day(expense.due),
            payment: expense.payment
              ? {
                  amount: expense.payment.amount,
                  method: expense.payment.method,
                  paidOn: day(expense.payment.paid),
                }
              : undefined,
          },
          ownerId,
        );
      }
      await this.use(CreateCashOutflowUseCase).execute(
        { ...DEMO_CASH_OUTFLOW, currency: DEMO_CURRENCY },
        receptionId,
      );
    });
  }

  /**
   * DX-150: gestiones de cobro y un compromiso de pago abierto de los deudores
   * de la cartera, por los mismos casos de uso que la API (recepción, en la
   * sede principal). El compromiso vence dentro de unos días: «Abierto».
   */
  private async createCollections(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    receptionId: string,
  ): Promise<void> {
    await this.inTenant(tenantId, locations.principal, async () => {
      for (const note of DEMO_COLLECTION_NOTES) {
        await this.use(CreateCollectionNoteUseCase).execute(
          patientIds[note.patientIndex],
          { channel: note.channel, outcome: note.outcome, text: note.text },
          receptionId,
        );
      }
    });
    const promise = DEMO_PAYMENT_PROMISE;
    await this.inTenant(tenantId, locations[promise.location], () =>
      this.use(CreatePaymentPromiseUseCase).execute(
        patientIds[promise.patientIndex],
        {
          amount: promise.amount,
          currency: DEMO_CURRENCY,
          dueDate: addCivilDays(
            civilDateIn(this.now, 'America/Bogota'),
            promise.dueInDays,
          ),
        },
        receptionId,
      ),
    );
  }

  /**
   * DX-040: dos opciones del mismo tratamiento (A: implante, B: puente)
   * presentadas hace unos días en la sede principal, por los mismos casos de
   * uso que la API: se arma la opción A, se crea su alternativa (que copia los
   * ítems y abre el grupo), se cambian los de la B y se presentan las dos.
   * Presentar usa un reloj atrasado para fechar la presentación en el pasado.
   */
  private async createPlanOptions(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    dentists: string[],
    catalog: Map<string, string>,
  ): Promise<void> {
    const spec = DEMO_PLAN_OPTIONS;
    const dentistId = dentists[spec.dentistIndex];
    const [optionA, optionB] = spec.options;
    const addItems = async (
      planId: string,
      items: readonly { code: string; tooth: string }[],
    ) => {
      for (const item of items) {
        await this.use(AddTreatmentPlanItemUseCase).execute(
          planId,
          {
            toothNumber: item.tooth,
            catalogItemId: catalogId(catalog, item.code),
          },
          { userId: dentistId, role: ClinicRole.DENTIST },
        );
      }
    };
    const presentedAt = daysAgoAt(this.now, spec.presentedDaysAgo, 10 * 60);
    const present = new PresentTreatmentPlanUseCase(
      this.app.get<TreatmentPlanRepository>(TREATMENT_PLAN_REPOSITORY, {
        strict: false,
      }),
      () => presentedAt,
    );

    await this.inTenant(tenantId, locations[spec.location], async () => {
      const a = await this.use(CreateTreatmentPlanUseCase).execute({
        patientId: patientIds[spec.patientIndex],
        currency: DEMO_CURRENCY,
        notes: spec.notes,
        createdById: dentistId,
      });
      await addItems(a.id, optionA.items);
      const b = await this.use(CreatePlanAlternativeUseCase).execute(a.id, {
        optionLabel: optionB.label,
        createdById: dentistId,
      });
      await this.use(UpdateTreatmentPlanUseCase).execute(
        a.id,
        { optionLabel: optionA.label },
        { role: ClinicRole.DENTIST },
      );
      const copied = await this.prisma.runWithTenant((tx) =>
        tx.treatmentPlanItem.findMany({
          where: { planId: b.id, deletedAt: null },
          select: { id: true },
        }),
      );
      for (const item of copied) {
        await this.use(RemoveTreatmentPlanItemUseCase).execute(item.id);
      }
      await addItems(b.id, optionB.items);
      await present.execute(a.id);
      await present.execute(b.id);
    });
  }

  /**
   * DX-012: el paciente acepta el presupuesto firmando en la sede principal,
   * por los mismos casos de uso que la API: se muestra el presupuesto y se
   * firma con su `contentHash`.
   */
  private async acceptWithSignature(
    tenantId: string,
    locationId: string,
    patientId: string,
    planId: string,
    dentistId: string,
  ): Promise<void> {
    await this.inTenant(tenantId, locationId, async () => {
      const shown = await this.use(GetPlanQuoteUseCase).execute(
        patientId,
        planId,
      );
      await this.use(AcceptTreatmentPlanUseCase).execute(
        patientId,
        planId,
        {
          signerName: shown.patient.name,
          signature: DEMO_PATIENT_SIGNATURE_PNG,
          contentHash: shown.contentHash,
        },
        { acceptedById: dentistId, ipAddress: null, userAgent: 'seed:demo' },
      );
    });
  }

  /**
   * DX-006: las 3 plantillas (las crea el ADMIN) y un consentimiento firmado
   * por los mismos casos de uso que la API, ligado al plan del paciente.
   */
  private async createConsents(
    ownerId: string,
    patientIds: string[],
    dentists: string[],
  ): Promise<void> {
    const templates: { id: string; version: number }[] = [];
    for (const spec of DEMO_CONSENT_TEMPLATES) {
      templates.push(
        await this.use(CreateConsentTemplateUseCase).execute(spec, ownerId),
      );
    }
    const { patientIndex, dentistIndex, templateIndex } = DEMO_SIGNED_CONSENT;
    const patientId = patientIds[patientIndex];
    const plan = await this.prisma.runWithTenant((tx) =>
      tx.treatmentPlan.findFirstOrThrow({
        where: { patientId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    );
    const template = templates[templateIndex];
    await this.use(SignPatientConsentUseCase).execute(
      patientId,
      {
        templateId: template.id,
        templateVersion: template.version,
        treatmentPlanId: plan.id,
        signerType: 'PATIENT',
        patientSignature: DEMO_PATIENT_SIGNATURE_PNG,
        professionalSignature: DEMO_PROFESSIONAL_SIGNATURE_PNG,
      },
      {
        recordedById: dentists[dentistIndex],
        ipAddress: null,
        userAgent: 'seed:demo',
      },
    );
  }

  /**
   * DX-007: dos exámenes periodontales FINAL del mismo paciente (inicial hace
   * ~6 meses y control reciente, mejor), por los mismos casos de uso que la
   * API, para enseñar el histórico y la comparación.
   */
  private async createPerioExams(
    patientIds: string[],
    dentists: string[],
  ): Promise<void> {
    const patientId = patientIds[DEMO_PERIO.patientIndex];
    const providerId = dentists[DEMO_PERIO.dentistIndex];
    const dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEMO_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const spec of DEMO_PERIO.exams) {
      const exam = await this.use(CreatePerioExamUseCase).execute(
        patientId,
        {
          examDate: dayFormat.format(
            daysAgoAt(this.now, spec.daysAgo, 12 * 60),
          ),
          notes: spec.notes,
        },
        providerId,
      );
      await this.use(SavePerioMeasuresUseCase).execute(
        patientId,
        exam.id,
        demoPerioMeasures(spec.phase),
      );
      await this.use(FinalizePerioExamUseCase).execute(patientId, exam.id);
    }
  }

  /**
   * DX-013: registro profesional y especialidad de los odontólogos, los
   * ajustes de la receta (los fija el ADMIN, auditado), las plantillas
   * típicas (las crea el ADMIN) y una receta post-exodoncia emitida, todo por
   * los mismos casos de uso que la API. Sin X-Location-Id: la sede principal.
   */
  private async createPrescriptions(
    ownerId: string,
    patientIds: string[],
    dentists: string[],
  ): Promise<void> {
    const ownerCtx: AuditRequestContext = {
      tenantId: this.tenantContext.getTenantId() as string,
      locationId: null,
      actor: { userId: ownerId, role: ClinicRole.ADMIN },
      requestId: null,
      ip: null,
      userAgent: null,
    };
    // DX-359: auditado como el PATCH del ADMIN.
    for (const [index, license] of DEMO_PROFESSIONAL_LICENSES.entries()) {
      await this.use(UpdateStaffUseCase).execute(
        {
          userId: dentists[index],
          professionalLicense: license,
          professionalSpecialty: DEMO_PROFESSIONAL_SPECIALTIES[index],
        },
        ownerCtx,
      );
    }
    // DX-324: antes de emitir, como lo haría el ADMIN en Ajustes › Recetas.
    await this.use(UpdatePrescriptionSettingsUseCase).execute(
      { ...DEMO_PRESCRIPTION_SETTINGS },
      ownerCtx,
    );
    for (const template of DEMO_PRESCRIPTION_TEMPLATES) {
      await this.use(CreatePrescriptionTemplateUseCase).execute(
        { name: template.name, notes: template.notes, items: template.items },
        ownerId,
      );
    }
    await this.use(IssuePrescriptionUseCase).execute(
      patientIds[DEMO_PRESCRIPTION.patientIndex],
      { items: [...DEMO_PRESCRIPTION.items], notes: DEMO_PRESCRIPTION.notes },
      dentists[DEMO_PRESCRIPTION.dentistIndex],
    );
  }

  /**
   * DX-191: implante y pilar del paciente del plan de implante, y un segundo
   * paciente con el MISMO lote (para la búsqueda por lote). Por el caso de
   * uso de la API; sin X-Location-Id: la sede principal.
   */
  private async createImplants(
    patientIds: string[],
    dentists: string[],
  ): Promise<void> {
    const dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEMO_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const spec of DEMO_IMPLANTS) {
      await this.use(RegisterImplantUseCase).execute(
        patientIds[spec.patientIndex],
        {
          toothNumber: spec.toothNumber,
          kind: spec.kind,
          manufacturer: spec.manufacturer,
          system: spec.system,
          reference: spec.reference,
          lot: spec.lot,
          diameterMm: spec.diameterMm,
          lengthMm: spec.lengthMm,
          sanitaryRegistration: spec.sanitaryRegistration,
          placedOn: dayFormat.format(
            daysAgoAt(this.now, spec.daysAgo, 10 * 60),
          ),
        },
        dentists[spec.dentistIndex],
      );
    }
  }

  private async createInventory(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    createdById: string,
  ): Promise<void> {
    for (const spec of DEMO_INVENTORY) {
      await this.inTenant(tenantId, locations[spec.location], async () => {
        const item = await this.use(CreateInventoryItemUseCase).execute(
          {
            name: spec.name,
            sku: spec.sku,
            unit: spec.unit,
            minStock: spec.minStock,
          },
          createdById,
        );
        for (const m of spec.movements) {
          await this.use(RecordInventoryMovementUseCase).execute(
            {
              itemId: item.id,
              type: m.type,
              quantity: m.quantity,
              reason: m.reason,
            },
            createdById,
          );
        }
      });
    }
  }
}

function catalogId(byCode: Map<string, string>, code: string): string {
  const id = byCode.get(code);
  if (!id) {
    throw new Error(`El catálogo por defecto no tiene el código ${code}`);
  }
  return id;
}

function printSummary(result: DemoSeedResult): void {
  const headline: Record<DemoSeedStatus, string> = {
    created: 'Clínica demo creada.',
    rebuilt: 'Clínica demo reconstruida (la anterior quedó retirada).',
    skipped:
      'La clínica demo ya existía: no se tocó nada (usa --reset para reconstruirla).',
  };
  const lines = [
    '',
    headline[result.status],
    `  URL:        ${result.url}`,
    `  Tenant:     ${result.tenantId}`,
    `  Contraseña: ${result.password} (la misma para todos)`,
    '',
    ...result.users.map((u) => `  ${u.role.padEnd(10)} ${u.email}`),
    '',
    ...(result.confirmationUrl
      ? [
          `  Confirmación pendiente (enlace del paciente): ${result.confirmationUrl}`,
          '',
        ]
      : []),
  ];
  console.log(lines.join('\n'));
}

if (require.main === module) {
  seedDemo({ reset: process.argv.includes('--reset') }).catch(
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
