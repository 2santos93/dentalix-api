import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppointmentStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { RegisterClinicUseCase } from '../src/modules/auth/application/use-cases/register-clinic.use-case';
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
import { CreateClinicalEntryUseCase } from '../src/modules/clinical-entries/application/use-cases/create-clinical-entry.use-case';
import { AddToothRecordUseCase } from '../src/modules/odontogram/application/use-cases/add-tooth-record.use-case';
import { CreateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/create-appointment.use-case';
import { UpdateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import { APPOINTMENT_REPOSITORY } from '../src/modules/appointments/domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../src/modules/appointments/domain/ports/appointment-repository.port';
import { CreateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/create-treatment-plan.use-case';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { UpdateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import { RecordPaymentUseCase } from '../src/modules/payments/application/use-cases/record-payment.use-case';
import { CreatePaymentPlanUseCase } from '../src/modules/payment-plans/application/use-cases/create-payment-plan.use-case';
import { CreateInventoryItemUseCase } from '../src/modules/inventory/application/use-cases/create-inventory-item.use-case';
import { RecordInventoryMovementUseCase } from '../src/modules/inventory/application/use-cases/record-inventory-movement.use-case';
import {
  DemoLocationKey,
  DEMO_TIMEZONE,
  daysAgoAt,
  planAppointments,
} from './demo/calendar';
import {
  DEMO_CLINIC_NAME,
  DEMO_CLINICAL_ENTRIES,
  DEMO_CURRENCY,
  DEMO_EMAIL_DOMAIN,
  DEMO_INVENTORY,
  DEMO_LOCATIONS,
  DEMO_PASSWORD,
  DEMO_PATIENTS,
  DEMO_PLANS,
  DEMO_PRICES,
  DEMO_PRIMARY_COLOR,
  DEMO_SUBDOMAIN,
  DEMO_TOOTH_RECORDS,
  DEMO_USERS,
  NORTE_SCHEDULE,
} from './demo/data';

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
 * IDEMPOTENCIA — "si el tenant demo ya existe, no hace nada":
 *   - Sin flags: si hay un tenant vivo con subdominio `demo`, no toca nada y
 *     solo vuelve a imprimir las credenciales. Correrlo dos veces no duplica.
 *   - `--reset`: retira EN BLANDO la demo anterior (tenant, membresías y
 *     usuarios @demo.dentalix.app con `deletedAt`, igual que el resto del
 *     producto: aquí nada se borra en duro) y la reconstruye con fechas
 *     relativas al hoy nuevo. Es lo que hay que correr cuando la agenda demo
 *     "envejece".
 *   - Si una corrida falla a medias, la demo incompleta se retira sola, así que
 *     la siguiente corrida empieza limpia.
 *
 * CONEXIÓN — por qué NO usa DIRECT_URL: todo pasa por la app real
 * (`NestFactory.createApplicationContext(AppModule)`), es decir, por
 * `PrismaService` con DATABASE_URL (rol `dentalix_app`, sujeto a RLS) y los
 * MISMOS casos de uso que llaman los controladores: registro de clínica,
 * invitación + aceptación, sedes, horarios, pacientes, planes, abonos, etc.
 * Cada escritura corre en `runWithTenant` con `app.current_tenant` fijado, así
 * que el WITH CHECK de RLS hace imposible que una fila caiga fuera del tenant
 * demo, y las reglas de negocio (horario de la sede, solapes, precios del
 * catálogo, cuotas, hashing argon2 de contraseñas...) son exactamente las del
 * producto. La única excepción son las citas YA pasadas: el caso de uso de
 * crear cita rechaza el pasado por diseño, así que se insertan con el MISMO
 * repositorio (que respeta las EXCLUDE de solapes) tras validar el horario con
 * el validador real (`fitsBusinessHours`), y se cierran con el caso de uso de
 * actualizar cita, que sí admite cerrar citas pasadas.
 */

export type DemoSeedStatus = 'created' | 'skipped' | 'rebuilt';

export interface DemoSeedOptions {
  /** Retira la demo existente (en blando) y la reconstruye. */
  reset?: boolean;
  /** "Hoy" de referencia; por defecto, el instante actual. */
  now?: Date;
  /** No imprime el resumen (tests). */
  quiet?: boolean;
}

export interface DemoSeedResult {
  status: DemoSeedStatus;
  tenantId: string;
  url: string;
  users: { email: string; role: string; password: string }[];
}

const DEMO_URL = `http://${DEMO_SUBDOMAIN}.localhost:3001`;
/** Las citas que empiezan antes de esto se tratan como pasadas (margen de reloj). */
const FUTURE_MARGIN_MS = 5 * 60 * 1000;

export async function seedDemo(
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed:demo se niega a correr con NODE_ENV=production: solo es para entornos locales.',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const seeder = new DemoSeeder(app, options.now ?? new Date());
    const existing = await seeder.findLiveDemoTenantId();

    let status: DemoSeedStatus;
    let tenantId: string;
    if (existing && !options.reset) {
      status = 'skipped';
      tenantId = existing;
    } else {
      if (existing) await seeder.retire(existing);
      tenantId = await seeder.build();
      status = existing ? 'rebuilt' : 'created';
    }

    const result: DemoSeedResult = {
      status,
      tenantId,
      url: DEMO_URL,
      users: DEMO_USERS.map((u) => ({
        email: u.email,
        role: u.role,
        password: DEMO_PASSWORD,
      })),
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

  constructor(
    private readonly app: INestApplicationContext,
    private readonly now: Date,
  ) {
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

  /** Retiro en blando de una demo (y de los usuarios demo, que son exclusivos). */
  async retire(tenantId: string): Promise<void> {
    const at = new Date();
    await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: at },
      }),
    );
    await this.prisma.user.updateMany({
      where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` }, deletedAt: null },
      data: { deletedAt: at },
    });
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { deletedAt: at },
    });
  }

  async build(): Promise<string> {
    // Usuarios demo huérfanos (p. ej. de un tenant retirado a mano) impedirían
    // el registro: se retiran antes, igual que en --reset.
    await this.prisma.user.updateMany({
      where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` }, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    const owner = DEMO_USERS[0];
    // Registro REAL: tenant + dueño ADMIN + "Sede principal" con horario por
    // defecto + catálogo semilla, en una sola transacción.
    const { tenantId, userId: ownerId } = await this.use(
      RegisterClinicUseCase,
    ).execute({
      clinicName: DEMO_CLINIC_NAME,
      subdomain: DEMO_SUBDOMAIN,
      email: owner.email,
      password: DEMO_PASSWORD,
      fullName: owner.fullName,
    });

    try {
      await this.populate(tenantId, ownerId);
    } catch (error) {
      await this.retire(tenantId);
      throw error;
    }
    return tenantId;
  }

  private inTenant<T>(
    tenantId: string,
    locationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tenantContext.run(tenantId, locationId, fn);
  }

  private async populate(tenantId: string, ownerId: string): Promise<void> {
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

    const patientIds = await this.inTenant(tenantId, undefined, () =>
      this.createPatients(receptionId),
    );

    await this.inTenant(tenantId, undefined, () =>
      this.createClinicalRecords(patientIds, dentists, catalog),
    );

    await this.createAppointments(
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
    );

    await this.createInventory(tenantId, locations, userIds[4]);
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
    const principal = await this.prisma.runWithTenant((tx) =>
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

  private async createPatients(createdById: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, p] of DEMO_PATIENTS.entries()) {
      const { city: cityName, birthDate, ...rest } = p;
      const city = await this.prisma.city.findFirst({
        where: { countryCode: 'CO', name: cityName },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const consentAt = daysAgoAt(this.now, 60 + index, 9 * 60);
      const patient = await this.use(CreatePatientUseCase).execute({
        ...rest,
        birthDate: new Date(`${birthDate}T00:00:00.000Z`),
        countryCode: city ? 'CO' : undefined,
        cityId: city?.id,
        dataConsentAccepted: true,
        dataConsentAt: consentAt,
        dataConsentPolicyVersion: 'v1',
        createdById,
      });
      ids.push(patient.id);
    }
    return ids;
  }

  private async createClinicalRecords(
    patientIds: string[],
    dentists: string[],
    catalog: Map<string, string>,
  ): Promise<void> {
    for (const e of DEMO_CLINICAL_ENTRIES) {
      await this.use(CreateClinicalEntryUseCase).execute(
        patientIds[e.patientIndex],
        {
          entryDate: daysAgoAt(this.now, e.daysAgo, 10 * 60),
          reason: e.reason,
          notes: e.notes,
        },
        dentists[e.dentistIndex],
      );
    }
    for (const r of DEMO_TOOTH_RECORDS) {
      const catalogItemId = catalogId(catalog, r.catalogCode);
      await this.use(AddToothRecordUseCase).execute(
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
    }
  }

  private async createAppointments(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    hours: Record<DemoLocationKey, BusinessHours | null>,
    patientIds: string[],
    dentists: string[],
    createdById: string,
  ): Promise<void> {
    const planned = planAppointments(
      this.now,
      patientIds.length,
      (key, start, end) => fitsBusinessHours(start, end, hours[key]),
    );
    const repo = this.app.get<AppointmentRepository>(APPOINTMENT_REPOSITORY, {
      strict: false,
    });

    for (const a of planned) {
      await this.inTenant(tenantId, locations[a.location], async () => {
        const input = {
          patientId: patientIds[a.patientIndex],
          providerId: dentists[a.dentistIndex],
          start: a.start,
          end: a.end,
          reason: a.reason,
          createdById,
        };
        const isFuture = a.start.getTime() >= Date.now() + FUTURE_MARGIN_MS;
        // Futuras: caso de uso real (horario, solapes, pertenencia). Pasadas:
        // el caso de uso las rechaza por diseño, así que van por el repositorio
        // (las EXCLUDE de solape siguen aplicando en la base).
        const created = isFuture
          ? await this.use(CreateAppointmentUseCase).execute(input)
          : await repo.create(input);
        if (a.status !== AppointmentStatus.SCHEDULED) {
          await this.use(UpdateAppointmentUseCase).execute(created.id, {
            status: a.status,
          });
        }
      });
    }
  }

  private async createPlansAndPayments(
    tenantId: string,
    locations: Record<DemoLocationKey, string>,
    patientIds: string[],
    dentists: string[],
    receptionId: string,
    catalog: Map<string, string>,
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
        for (const item of spec.items) {
          // Sin `price`: el caso de uso toma la tarifa del catálogo.
          const added = await this.use(AddTreatmentPlanItemUseCase).execute(
            plan.id,
            {
              toothNumber: item.tooth,
              surfaces: item.surfaces,
              catalogItemId: catalogId(catalog, item.code),
            },
          );
          if (item.status !== 'PROPOSED') {
            // DONE refleja el ítem en el odontograma (lo hace el caso de uso).
            await this.use(UpdateTreatmentPlanItemUseCase).execute(
              added.id,
              { status: item.status },
              dentistId,
            );
          }
        }
        if (spec.status !== 'DRAFT') {
          await this.use(UpdateTreatmentPlanUseCase).execute(plan.id, {
            status: spec.status,
          });
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
    `  Contraseña: ${DEMO_PASSWORD} (la misma para todos)`,
    '',
    ...result.users.map((u) => `  ${u.role.padEnd(10)} ${u.email}`),
    '',
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
