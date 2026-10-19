import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentStatus,
  ClinicRole,
  ScheduleBlockKind,
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
import { UpdateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import { ListAppointmentsUseCase } from '../src/modules/appointments/application/use-cases/list-appointments.use-case';
import { CreateAppointmentTypeUseCase } from '../src/modules/appointment-types/application/use-cases/appointment-types.use-cases';
import { LoadSampleNoteTemplatesUseCase } from '../src/modules/clinical-note-templates/application/use-cases/clinical-note-templates.use-cases';
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
import { RecordPaymentUseCase } from '../src/modules/payments/application/use-cases/record-payment.use-case';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  CreateCollectionNoteUseCase,
  CreatePaymentPromiseUseCase,
} from '../src/modules/collections/application/use-cases/collections.use-cases';
import { VoidPaymentUseCase } from '../src/modules/payments/application/use-cases/void-payment.use-case';
import {
  CloseCashSessionUseCase,
  OpenCashSessionUseCase,
} from '../src/modules/cash-sessions/application/use-cases/cash-sessions.use-cases';
import { CreatePaymentPlanUseCase } from '../src/modules/payment-plans/application/use-cases/create-payment-plan.use-case';
import { CreateInventoryItemUseCase } from '../src/modules/inventory/application/use-cases/create-inventory-item.use-case';
import { RecordInventoryMovementUseCase } from '../src/modules/inventory/application/use-cases/record-inventory-movement.use-case';
import { CreateConsentTemplateUseCase } from '../src/modules/consents/application/use-cases/consent-templates.use-cases';
import { SignPatientConsentUseCase } from '../src/modules/consents/application/use-cases/patient-consents.use-cases';
import { CreatePrescriptionTemplateUseCase } from '../src/modules/prescriptions/application/use-cases/prescription-templates.use-cases';
import { IssuePrescriptionUseCase } from '../src/modules/prescriptions/application/use-cases/prescriptions.use-cases';
import { RegisterImplantUseCase } from '../src/modules/implants/application/use-cases/implants.use-cases';
import { UpdateStaffUseCase } from '../src/modules/staff/application/use-cases/update-staff.use-case';
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
  planAppointments,
} from './demo/calendar';
import { CreateScheduleBlockUseCase } from '../src/modules/schedule-blocks/application/use-cases/schedule-blocks.use-cases';
import {
  CreateWaitlistEntryUseCase,
  DismissWaitlistEntryUseCase,
  ListWaitlistUseCase,
} from '../src/modules/waitlist/application/use-cases/waitlist.use-cases';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { UpdatePatientCommunicationUseCase } from '../src/modules/patients/application/use-cases/patient-communication.use-cases';
import {
  DEMO_CLINIC_NAME,
  DEMO_CLINICAL_ENTRIES,
  DEMO_CLINICAL_ADDENDA,
  DEMO_COMMUNICATION,
  DEMO_TEMPLATE_EVOLUTIONS,
  DEMO_CONSENT_TEMPLATES,
  DEMO_APPOINTMENT_TYPES,
  DEMO_LUNCH,
  DEMO_VACATION,
  DEMO_WAITLIST,
  DEMO_PERIO,
  DEMO_IMPLANTS,
  DEMO_PRESCRIPTION,
  DEMO_PRESCRIPTION_TEMPLATES,
  DEMO_PROFESSIONAL_LICENSES,
  demoPerioMeasures,
  DEMO_CURRENCY,
  DEMO_EMAIL_DOMAIN,
  DEMO_INVENTORY,
  DEMO_LOCATIONS,
  DEMO_PASSWORD,
  DEMO_PATIENTS,
  DEMO_RESPONSIBLES,
  DEMO_PLANS,
  DEMO_COLLECTION_NOTES,
  DEMO_PAYMENT_PROMISE,
  DEMO_PLAN_OPTIONS,
  DEMO_PRICES,
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

class DemoSeeder {
  private readonly prisma: PrismaService;
  private readonly tenantContext: TenantContextService;
  /** "Hoy" de referencia para fechar los datos (no para decidir pasado/futuro). */
  private readonly now = new Date();

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
      this.createClinicalRecords(patientIds, dentists, catalog),
    );

    const typeByReason = await this.inTenant(tenantId, undefined, () =>
      this.createAppointmentTypes(ownerId),
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

    await this.inTenant(tenantId, undefined, () =>
      this.createTemplateEvolutions(ownerId, attended),
    );

    await this.createScheduleBlocksAndWaitlist(
      tenantId,
      locations,
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

    await this.createPlanOptions(
      tenantId,
      locations,
      patientIds,
      dentists,
      catalog,
    );

    await this.createCollections(tenantId, locations, patientIds, receptionId);

    await this.createCashSessions(tenantId, locations, receptionId);

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
      const { token } = await this.use(CreateInvitationUseCase).execute({
        fullName: member.fullName,
        email: member.email,
        role: member.role,
        invitedById: ownerId,
      });
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
    });
    // Nace con el horario por defecto (como cualquier sede nueva) y luego se
    // le pone el suyo con el caso de uso de /settings/horarios.
    const norte = await this.use(CreateLocationUseCase).execute(
      DEMO_LOCATIONS.norte,
    );
    await this.inTenant(tenantId, norte.id, () =>
      this.use(ReplaceLocationScheduleUseCase).execute({
        timezone: DEMO_TIMEZONE,
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
    for (const [index, p] of DEMO_PATIENTS.entries()) {
      const { city: cityName, birthDate, ...rest } = p;
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
        ...(rest.medicalHistory
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
            // DONE refleja el ítem en el odontograma (lo hace el caso de uso).
            await this.use(UpdateTreatmentPlanItemUseCase).execute(
              added.id,
              { status: item.status },
              dentist,
            );
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
        await this.inTenant(tenantId, locations[payment.location], () =>
          this.use(RecordPaymentUseCase).execute(
            planId,
            {
              amount: payment.amount,
              currency: DEMO_CURRENCY,
              paidAt: daysAgoAt(this.now, payment.daysAgo, 11 * 60 + i * 20),
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
            paidAt: civilDateIn(this.now, DEMO_TIMEZONE),
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
   * DX-013: registro profesional de los odontólogos, las plantillas típicas
   * (las crea el ADMIN) y una receta post-exodoncia emitida, todo por los
   * mismos casos de uso que la API. Sin X-Location-Id: la sede principal (CO).
   */
  private async createPrescriptions(
    ownerId: string,
    patientIds: string[],
    dentists: string[],
  ): Promise<void> {
    for (const [index, license] of DEMO_PROFESSIONAL_LICENSES.entries()) {
      await this.use(UpdateStaffUseCase).execute({
        userId: dentists[index],
        professionalLicense: license,
      });
    }
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
