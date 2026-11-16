import { ConflictException, Injectable } from '@nestjs/common';
import {
  Prisma,
  type DentalLab,
  type DentalLabOrder,
  type DentalLabService,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadLocationBusinessCalendar } from '../../../shared/locations/location-business-calendar';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { clinicLogoPublicUrl } from '../../../shared/storage/clinic-logo-url';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { civilDateIn } from '../../../shared/time/civil-day';
import { ageInYears } from '../../odontogram/domain/dentition';
import {
  documentText,
  documentTypeName,
} from '../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import type {
  DentalLabServiceView,
  DentalLabView,
  LabOrderPrintView,
  LabOrderRecord,
  LabOrderView,
} from '../domain/entities';
import {
  LABS_PER_CLINIC_MAX,
  LAB_MESSAGES,
  SERVICES_PER_LAB_MAX,
  deriveLabOrderStatus,
  labOrderOverdue,
  type LabOrderStatus,
} from '../domain/lab-order-rules';
import type {
  CatalogWriteResult,
  LabInput,
  LabOrderListQuery,
  LabOrderWrite,
  LabPatch,
  LabRepository,
  LabServiceInput,
  LabServicePatch,
  LocationCalendarInfo,
  NewLabOrderInput,
} from '../domain/ports/lab-repository.port';

/** Un `@db.Date` llega como medianoche UTC: su día civil es el de UTC. */
const day = (value: Date): string => value.toISOString().slice(0, 10);
const dayOrNull = (value: Date | null): string | null =>
  value ? day(value) : null;
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

function mapService(row: DentalLabService): DentalLabServiceView {
  return {
    id: row.id,
    labId: row.labId,
    name: row.name,
    leadTimeBusinessDays: row.leadTimeBusinessDays,
    referencePrice: row.referencePrice ? row.referencePrice.toFixed(2) : null,
    referenceCurrency: row.referenceCurrency,
    active: row.active,
  };
}

function mapLab(
  row: DentalLab & { services: DentalLabService[] },
): DentalLabView {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    active: row.active,
    services: row.services.map(mapService),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOrder(row: DentalLabOrder): LabOrderRecord {
  return {
    id: row.id,
    number: row.number,
    locationId: row.locationId,
    patientId: row.patientId,
    professionalMembershipId: row.professionalMembershipId,
    labId: row.labId,
    serviceId: row.serviceId,
    treatmentPlanItemId: row.treatmentPlanItemId,
    appointmentId: row.appointmentId,
    replacesOrderId: row.replacesOrderId,
    description: row.description,
    toothNumbers: row.toothNumbers,
    shade: row.shade,
    material: row.material,
    instructions: row.instructions,
    dueOn: dayOrNull(row.dueOn),
    sentAt: row.sentAt,
    sentById: row.sentById,
    receivedAt: row.receivedAt,
    receivedById: row.receivedById,
    checkedAt: row.checkedAt,
    checkedById: row.checkedById,
    cancelledAt: row.cancelledAt,
    cancelledById: row.cancelledById,
    cancelReason: row.cancelReason,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Violación de un único (nombre repetido): P2002 o el nombre del índice. */
function isUniqueViolation(error: unknown, index: string): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002') ||
    (error instanceof Error && error.message.includes(index))
  );
}

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003') ||
    (error instanceof Error && error.message.includes(constraint))
  );
}

/** Nombres de miembros de la clínica (el usuario es global; la membresía tiene RLS). */
async function memberNames(
  tx: Prisma.TransactionClient,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await tx.clinicMembership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { fullName: true } } },
  });
  return new Map(rows.map((r) => [r.userId, r.user.fullName]));
}

const ORDER_INCLUDE = {
  patient: { select: { id: true, firstName: true, lastName: true } },
  location: { select: { id: true, name: true, timeZone: true } },
  lab: { select: { id: true, name: true } },
  service: { select: { id: true, name: true, leadTimeBusinessDays: true } },
  membership: {
    select: { id: true, userId: true, user: { select: { fullName: true } } },
  },
  treatmentPlanItem: {
    select: { id: true, planId: true, toothNumber: true, catalogItemId: true },
  },
  appointment: { select: { id: true, start: true } },
  replacesOrder: { select: { id: true, number: true } },
  replacedBy: {
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
  },
} satisfies Prisma.DentalLabOrderInclude;

/** Condición SQL de cada estado derivado (las mismas reglas que el dominio). */
const STATUS_SQL: Record<LabOrderStatus, Prisma.Sql> = {
  DRAFT: Prisma.sql`(o."sentAt" IS NULL AND o."cancelledAt" IS NULL)`,
  SENT: Prisma.sql`(o."sentAt" IS NOT NULL AND o."receivedAt" IS NULL AND o."cancelledAt" IS NULL)`,
  RECEIVED: Prisma.sql`(o."receivedAt" IS NOT NULL AND o."checkedAt" IS NULL AND o."cancelledAt" IS NULL)`,
  CHECKED: Prisma.sql`(o."checkedAt" IS NOT NULL AND o."cancelledAt" IS NULL)`,
  CANCELLED: Prisma.sql`(o."cancelledAt" IS NOT NULL)`,
};

/**
 * Filtro de la lista de la sede (DX-017). «Atrasada»: fecha prometida
 * anterior a hoy en la sede, sin recibir ni anular (el predicado del índice
 * parcial dental_lab_orders_pending_idx).
 */
export function labOrderListWhere(
  q: LabOrderListQuery & { tenantId: string },
): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`o."tenantId" = ${q.tenantId}::uuid`,
    Prisma.sql`o."locationId" = ${q.locationId}::uuid`,
  ];
  if (q.statuses.length > 0) {
    parts.push(
      Prisma.sql`(${Prisma.join(
        q.statuses.map((s) => STATUS_SQL[s]),
        ' OR ',
      )})`,
    );
  }
  if (q.labId) parts.push(Prisma.sql`o."labId" = ${q.labId}::uuid`);
  if (q.from) parts.push(Prisma.sql`o."dueOn" >= ${q.from}::date`);
  if (q.to) parts.push(Prisma.sql`o."dueOn" <= ${q.to}::date`);
  if (q.overdue) {
    parts.push(
      Prisma.sql`(o."receivedAt" IS NULL AND o."cancelledAt" IS NULL AND o."dueOn" < ${q.today}::date)`,
    );
  }
  return Prisma.join(parts, ' AND ');
}

@Injectable()
export class PrismaLabRepository implements LabRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.getTenantId();
    if (!id) throw new Error('No tenant in context');
    return id;
  }

  // -------------------------------------------------------------------------
  // Catálogo
  // -------------------------------------------------------------------------

  listLabs(includeInactive: boolean): Promise<DentalLabView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.dentalLab.findMany({
        where: includeInactive ? {} : { active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: {
          services: {
            where: includeInactive ? {} : { active: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
          },
        },
      });
      return rows.map(mapLab);
    });
  }

  async findLab(labId: string): Promise<DentalLabView | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.dentalLab.findFirst({
        where: { id: labId },
        include: { services: { orderBy: [{ name: 'asc' }, { id: 'asc' }] } },
      }),
    );
    return row ? mapLab(row) : null;
  }

  async createLab(input: LabInput): Promise<CatalogWriteResult<DentalLabView>> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // Candado de la clínica: dos altas a la vez no se saltan el tope.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dental_labs:${tenantId}`}, 0))`;
        if ((await tx.dentalLab.count()) >= LABS_PER_CLINIC_MAX) {
          return { kind: 'LIMIT' } as const;
        }
        const row = await tx.dentalLab.create({
          data: { tenantId, ...input },
          include: { services: true },
        });
        return { kind: 'OK', value: mapLab(row) } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dental_labs_tenant_name_key')) {
        return { kind: 'NAME_TAKEN' };
      }
      throw error;
    }
  }

  async updateLab(
    labId: string,
    patch: LabPatch,
  ): Promise<
    CatalogWriteResult<{ before: DentalLabView; after: DentalLabView }>
  > {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "dental_labs" WHERE "id" = ${labId}::uuid FOR UPDATE`;
        if (!locked) return { kind: 'NOT_FOUND' } as const;
        const before = await tx.dentalLab.findUniqueOrThrow({
          where: { id: labId },
          include: { services: { orderBy: [{ name: 'asc' }, { id: 'asc' }] } },
        });
        const after = await tx.dentalLab.update({
          where: { id: labId },
          data: patch,
          include: { services: { orderBy: [{ name: 'asc' }, { id: 'asc' }] } },
        });
        return {
          kind: 'OK',
          value: { before: mapLab(before), after: mapLab(after) },
        } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dental_labs_tenant_name_key')) {
        return { kind: 'NAME_TAKEN' };
      }
      throw error;
    }
  }

  async findService(serviceId: string): Promise<DentalLabServiceView | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.dentalLabService.findFirst({ where: { id: serviceId } }),
    );
    return row ? mapService(row) : null;
  }

  async createService(
    labId: string,
    input: LabServiceInput,
  ): Promise<CatalogWriteResult<DentalLabServiceView>> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // El laboratorio, bloqueado: dos altas a la vez no se saltan el tope.
        const [lab] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "dental_labs" WHERE "id" = ${labId}::uuid FOR UPDATE`;
        if (!lab) return { kind: 'NOT_FOUND' } as const;
        if (
          (await tx.dentalLabService.count({ where: { labId } })) >=
          SERVICES_PER_LAB_MAX
        ) {
          return { kind: 'LIMIT' } as const;
        }
        const row = await tx.dentalLabService.create({
          data: { tenantId, labId, ...input },
        });
        return { kind: 'OK', value: mapService(row) } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dental_lab_services_lab_name_key')) {
        return { kind: 'NAME_TAKEN' };
      }
      if (isForeignKeyViolation(error, 'dental_lab_services_currency_fkey')) {
        return { kind: 'CURRENCY_UNKNOWN' };
      }
      throw error;
    }
  }

  async updateService(
    labId: string,
    serviceId: string,
    patch: LabServicePatch,
  ): Promise<
    CatalogWriteResult<{
      before: DentalLabServiceView;
      after: DentalLabServiceView;
    }>
  > {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "dental_lab_services"
           WHERE "id" = ${serviceId}::uuid AND "labId" = ${labId}::uuid FOR UPDATE`;
        if (!locked) return { kind: 'NOT_FOUND' } as const;
        const before = await tx.dentalLabService.findUniqueOrThrow({
          where: { id: serviceId },
        });
        const after = await tx.dentalLabService.update({
          where: { id: serviceId },
          data: patch,
        });
        return {
          kind: 'OK',
          value: { before: mapService(before), after: mapService(after) },
        } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dental_lab_services_lab_name_key')) {
        return { kind: 'NAME_TAKEN' };
      }
      if (isForeignKeyViolation(error, 'dental_lab_services_currency_fkey')) {
        return { kind: 'CURRENCY_UNKNOWN' };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Contexto
  // -------------------------------------------------------------------------

  writeLocationId(): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }

  async locationExists(locationId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  today(now: Date, locationId: string): Promise<string> {
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.findFirstOrThrow({
        where: { id: locationId },
        select: { id: true, timeZone: true },
      });
      return civilDateIn(now, requireLocationTimeZone(location));
    });
  }

  calendarOf(locationId: string): Promise<LocationCalendarInfo> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const calendar = await loadLocationBusinessCalendar(
        tx,
        tenantId,
        locationId,
      );
      // Horario de la sede: un día sin tramos vivos está cerrado. Sin horario
      // (o retirado), sin restricción.
      const schedule = await tx.locationSchedule.findFirst({
        where: { locationId, deletedAt: null },
        select: {
          ranges: { where: { deletedAt: null }, select: { weekday: true } },
        },
      });
      return {
        calendar: {
          workingWeekdays: calendar.workingWeekdays,
          holidays: calendar.holidays,
        },
        timeZone: calendar.timeZone,
        openWeekdays: schedule
          ? [...new Set(schedule.ranges.map((r) => r.weekday))].sort()
          : null,
      };
    });
  }

  async membershipOf(
    userId: string,
  ): Promise<{ id: string; role: string } | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null },
        select: { id: true, role: true },
      }),
    );
    return row ?? null;
  }

  async planItemOfPatient(patientId: string, itemId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.treatmentPlanItem.findFirst({
        where: { id: itemId, patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async appointmentOfPatient(
    patientId: string,
    appointmentId: string,
  ): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.appointment.findFirst({
        where: { id: appointmentId, patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async orderOfPatient(patientId: string, orderId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.dentalLabOrder.findFirst({
        where: { id: orderId, patientId },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  // -------------------------------------------------------------------------
  // Órdenes
  // -------------------------------------------------------------------------

  createOrder(input: NewLabOrderInput): Promise<string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // El paciente vivo, con candado (el orden de archivar y fusionar).
      await lockLivePatientOrConflict(tx, input.patientId);
      const row = await tx.dentalLabOrder.create({
        data: {
          tenantId,
          patientId: input.patientId,
          locationId: input.locationId,
          professionalMembershipId: input.professionalMembershipId,
          labId: input.labId,
          serviceId: input.serviceId,
          treatmentPlanItemId: input.treatmentPlanItemId,
          appointmentId: input.appointmentId,
          replacesOrderId: input.replacesOrderId,
          description: input.description,
          toothNumbers: input.toothNumbers,
          shade: input.shade,
          material: input.material,
          instructions: input.instructions,
          dueOn: input.dueOn ? dateOf(input.dueOn) : null,
          createdById: input.createdById,
          // Lo sustituye el trigger por el siguiente de la clínica.
          number: 0,
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  async findOrder(orderId: string): Promise<LabOrderRecord | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.dentalLabOrder.findFirst({ where: { id: orderId } }),
    );
    return row ? mapOrder(row) : null;
  }

  async updateOrder(
    orderId: string,
    expectedUpdatedAt: Date,
    write: LabOrderWrite,
  ): Promise<boolean> {
    const { dueOn, ...rest } = write;
    const data: Prisma.DentalLabOrderUncheckedUpdateManyInput = {
      ...rest,
      ...(dueOn !== undefined
        ? { dueOn: dueOn === null ? null : dateOf(dueOn) }
        : {}),
    };
    try {
      const { count } = await this.prisma.runWithTenant((tx) =>
        tx.dentalLabOrder.updateMany({
          where: { id: orderId, updatedAt: expectedUpdatedAt },
          data,
        }),
      );
      return count === 1;
    } catch (error) {
      // La guarda de la BD (orden anulada o enviada que otro cambió a la vez):
      // 409 genérico, sin el texto de la orden.
      if (
        error instanceof Error &&
        error.message.includes('dental_lab_orders:')
      ) {
        throw new ConflictException(LAB_MESSAGES.concurrent);
      }
      throw error;
    }
  }

  views(ids: string[], now: Date): Promise<LabOrderView[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.dentalLabOrder.findMany({
        where: { id: { in: ids } },
        include: ORDER_INCLUDE,
      });
      const catalogIds = [
        ...new Set(
          rows.flatMap((r) =>
            r.treatmentPlanItem ? [r.treatmentPlanItem.catalogItemId] : [],
          ),
        ),
      ];
      const catalog = catalogIds.length
        ? await tx.dentalCatalogItem.findMany({
            where: { id: { in: catalogIds } },
            select: { id: true, labelEs: true },
          })
        : [];
      const procedure = new Map(catalog.map((c) => [c.id, c.labelEs]));
      const names = await memberNames(
        tx,
        rows.flatMap((r) => [
          r.createdById,
          r.sentById,
          r.receivedById,
          r.checkedById,
          r.cancelledById,
        ]),
      );
      const person = (id: string | null) =>
        id ? { id, fullName: names.get(id) ?? '' } : null;
      const todayByZone = new Map<string, string>();
      const byId = new Map(
        rows.map((row) => {
          const zone = requireLocationTimeZone(row.location);
          let today = todayByZone.get(zone);
          if (!today) {
            today = civilDateIn(now, zone);
            todayByZone.set(zone, today);
          }
          const record = mapOrder(row);
          const view: LabOrderView = {
            id: row.id,
            number: row.number,
            status: deriveLabOrderStatus(record),
            ...labOrderOverdue(record, today),
            patientId: row.patientId,
            patient: {
              id: row.patient.id,
              fullName:
                `${row.patient.firstName} ${row.patient.lastName}`.trim(),
            },
            locationId: row.locationId,
            location: { id: row.location.id, name: row.location.name },
            lab: { id: row.lab.id, name: row.lab.name },
            service: row.service
              ? {
                  id: row.service.id,
                  name: row.service.name,
                  leadTimeBusinessDays: row.service.leadTimeBusinessDays,
                }
              : null,
            professional: {
              membershipId: row.membership.id,
              userId: row.membership.userId,
              fullName: row.membership.user.fullName,
            },
            description: row.description,
            toothNumbers: row.toothNumbers,
            shade: row.shade,
            material: row.material,
            instructions: row.instructions,
            clinicalRedacted: false,
            dueOn: record.dueOn,
            sentAt: row.sentAt,
            sentBy: person(row.sentById),
            receivedAt: row.receivedAt,
            receivedBy: person(row.receivedById),
            checkedAt: row.checkedAt,
            checkedBy: person(row.checkedById),
            cancelledAt: row.cancelledAt,
            cancelledBy: person(row.cancelledById),
            cancelReason: row.cancelReason,
            treatmentPlanItem: row.treatmentPlanItem
              ? {
                  id: row.treatmentPlanItem.id,
                  planId: row.treatmentPlanItem.planId,
                  toothNumber: row.treatmentPlanItem.toothNumber,
                  procedureName:
                    procedure.get(row.treatmentPlanItem.catalogItemId) ?? '',
                }
              : null,
            appointment: row.appointment
              ? { id: row.appointment.id, start: row.appointment.start }
              : null,
            replacesOrder: row.replacesOrder,
            replacedBy: row.replacedBy,
            createdAt: row.createdAt,
            createdBy: person(row.createdById)!,
            updatedAt: row.updatedAt,
          };
          return [row.id, view] as const;
        }),
      );
      return ids.flatMap((id) => {
        const view = byId.get(id);
        return view ? [view] : [];
      });
    });
  }

  patientOrderIds(
    patientId: string,
    page: number,
    pageSize: number,
  ): Promise<{ ids: string[]; total: number }> {
    return this.prisma.runWithTenant(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.dentalLabOrder.findMany({
          where: { patientId },
          orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true },
        }),
        tx.dentalLabOrder.count({ where: { patientId } }),
      ]);
      return { ids: rows.map((r) => r.id), total };
    });
  }

  listOrderIds(
    query: LabOrderListQuery,
  ): Promise<{ ids: string[]; total: number }> {
    const where = labOrderListWhere({ ...query, tenantId: this.tenantId() });
    const offset = (query.page - 1) * query.pageSize;
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT o."id" FROM "dental_lab_orders" o
         WHERE ${where}
         ORDER BY (o."dueOn" < ${query.today}::date AND o."receivedAt" IS NULL
                   AND o."cancelledAt" IS NULL) DESC,
                  o."dueOn" ASC NULLS LAST,
                  o."number" DESC
         LIMIT ${query.pageSize} OFFSET ${offset}`;
      const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "dental_lab_orders" o WHERE ${where}`;
      return { ids: rows.map((r) => r.id), total };
    });
  }

  async printHeaders(
    order: LabOrderView,
    now: Date,
  ): Promise<Omit<LabOrderPrintView, 'order' | 'printedAt'>> {
    const tenantId = this.tenantId();
    const names = await this.documentTypeNames.get(order.locationId);
    return this.prisma.runWithTenant(async (tx) => {
      const [tenant, location, membership, patient] = await Promise.all([
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            legalName: true,
            taxIdLabel: true,
            taxId: true,
            contactPhone: true,
            contactEmail: true,
            logoKey: true,
          },
        }),
        tx.location.findFirstOrThrow({
          where: { id: order.locationId },
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
            healthRegistrationNumber: true,
            showHealthRegistrationNumber: true,
            timeZone: true,
          },
        }),
        tx.clinicMembership.findFirstOrThrow({
          where: { id: order.professional.membershipId },
          select: {
            professionalLicense: true,
            professionalSpecialty: true,
            user: { select: { fullName: true } },
          },
        }),
        tx.patient.findFirstOrThrow({
          where: { id: order.patientId },
          select: {
            firstName: true,
            lastName: true,
            birthDate: true,
            documentType: true,
            docTypeLabel: true,
            docNumber: true,
          },
        }),
      ]);
      const today = civilDateIn(now, requireLocationTimeZone(location));
      const birthDate = dayOrNull(patient.birthDate);
      return {
        clinic: {
          name: tenant.name,
          legalName: tenant.legalName?.trim() || null,
          taxIdLabel: tenant.taxIdLabel?.trim() || null,
          taxId: tenant.taxId?.trim() || null,
          phone: tenant.contactPhone?.trim() || null,
          email: tenant.contactEmail?.trim() || null,
          logoUrl: clinicLogoPublicUrl(tenant.logoKey),
        },
        location: {
          name: location.name,
          address: location.address?.trim() || null,
          phone: location.phone?.trim() || null,
          healthRegistrationNumber: location.showHealthRegistrationNumber
            ? location.healthRegistrationNumber?.trim() || null
            : null,
        },
        professional: {
          fullName: membership.user.fullName,
          license: membership.professionalLicense?.trim() || null,
          specialty: membership.professionalSpecialty?.trim() || null,
        },
        patient: {
          fullName: `${patient.firstName} ${patient.lastName}`.trim(),
          document: documentText(
            documentTypeName(patient.documentType, patient.docTypeLabel, names),
            patient.docNumber,
          ),
          birthDate,
          ageYears: birthDate
            ? Math.max(0, ageInYears(birthDate, today))
            : null,
        },
      };
    });
  }
}
