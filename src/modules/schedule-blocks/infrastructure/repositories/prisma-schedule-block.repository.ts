import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { loadLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';
import type { ScheduleBlock } from '../../domain/entities/schedule-block.entity';
import { IN_CLINIC_STATUSES } from '../../../appointments/domain/patient-flow';
import type {
  AffectingBlocks,
  AffectingBlocksQuery,
  AffectedAppointmentsPage,
  CreateScheduleBlockRepoInput,
  ListScheduleBlocksParams,
  ScheduleBlockRepository,
  ScheduleBlockScope,
  UpdateScheduleBlockRepoInput,
} from '../../domain/ports/schedule-block-repository.port';

type PrismaScheduleBlock = Prisma.ScheduleBlockGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaScheduleBlock): ScheduleBlock {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    providerId: row.providerId,
    start: row.start,
    end: row.end,
    kind: row.kind,
    allowsBooking: row.allowsBooking,
    note: row.note,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Solape medio abierto con `[from, to)`: `start < to AND end > from`. */
function overlapping(from: Date, to: Date): Prisma.ScheduleBlockWhereInput {
  return { deletedAt: null, start: { lt: to }, end: { gt: from } };
}

/** Bloqueos que afectan a `providerId` en `locationId` (ver `blockAffects`). */
function affectingWhere(
  providerId: string,
  locationId: string,
): Prisma.ScheduleBlockWhereInput {
  return {
    OR: [
      { providerId, locationId: null },
      { providerId, locationId },
      { providerId: null, locationId },
    ],
  };
}

/** Las citas que caen bajo el alcance de un bloqueo. */
function affectedAppointmentsWhere(
  scope: ScheduleBlockScope,
): Prisma.AppointmentWhereInput {
  if (scope.providerId === null) {
    // `scheduleBlockScopeError` ya lo descartó: nunca se lista "todo".
    if (scope.locationId === null)
      throw new Error('Bloqueo sin sede ni profesional');
    return { locationId: scope.locationId };
  }
  return {
    providerId: scope.providerId,
    ...(scope.locationId !== null ? { locationId: scope.locationId } : {}),
  };
}

@Injectable()
export class PrismaScheduleBlockRepository implements ScheduleBlockRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  list(params: ListScheduleBlocksParams): Promise<ScheduleBlock[]> {
    const locationId = params.locationId ?? this.tenantContext.getLocationId();
    const and: Prisma.ScheduleBlockWhereInput[] = [
      overlapping(params.from, params.to),
    ];
    // Con sede: los de esa sede y los de profesional "en todas las sedes".
    if (locationId) and.push({ OR: [{ locationId }, { locationId: null }] });
    // Con profesionales: los suyos y los de toda la sede.
    if (params.providerIds) {
      and.push({
        OR: [{ providerId: { in: params.providerIds } }, { providerId: null }],
      });
    }
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.scheduleBlock.findMany({
        where: { AND: and },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<ScheduleBlock | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.scheduleBlock.findFirst({
        where: { id, deletedAt: null },
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(input: CreateScheduleBlockRepoInput): Promise<ScheduleBlock> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.scheduleBlock.create({
        data: {
          tenantId,
          providerId: input.providerId,
          locationId: input.locationId,
          start: input.start,
          end: input.end,
          kind: input.kind,
          allowsBooking: input.allowsBooking,
          note: input.note,
          createdById: input.createdById,
          updatedById: input.createdById,
        },
      }),
    );
    return mapToEntity(row);
  }

  /** Por `id` bajo RLS; el use-case ya comprobó que existe y está vivo. */
  async update(
    id: string,
    patch: UpdateScheduleBlockRepoInput,
  ): Promise<ScheduleBlock> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.scheduleBlock.update({
        where: { id },
        data: {
          start: patch.start,
          end: patch.end,
          kind: patch.kind,
          allowsBooking: patch.allowsBooking,
          note: patch.note,
          updatedById: patch.updatedById,
        },
      }),
    );
    return mapToEntity(row);
  }

  async softDelete(id: string, deletedById: string): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.scheduleBlock.update({
        where: { id },
        data: { deletedAt: new Date(), updatedById: deletedById },
      }),
    );
  }

  findAffecting(query: AffectingBlocksQuery): Promise<AffectingBlocks> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La misma resolución de sede que usa el alta de la cita (sede del
      // request o la sede por defecto): validar contra los bloqueos de una sede
      // y escribir en otra sería una validación que miente.
      const locationId =
        query.locationId ??
        this.tenantContext.getLocationId() ??
        (await resolveDefaultLocationId(tx));
      const rows = await tx.scheduleBlock.findMany({
        where: {
          AND: [
            overlapping(query.start, query.end),
            affectingWhere(query.providerId, locationId),
          ],
        },
        orderBy: { start: 'asc' },
      });
      const zones = await loadLocationTimeZones(tx, tenantId, [locationId]);
      return {
        locationId,
        timeZone: zones.get(locationId) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE,
        blocks: rows.map(mapToEntity),
      };
    });
  }

  findAffectedAppointments(
    scope: ScheduleBlockScope & { start: Date; end: Date },
    limit: number,
  ): Promise<AffectedAppointmentsPage> {
    const where: Prisma.AppointmentWhereInput = {
      ...affectedAppointmentsWhere(scope),
      deletedAt: null,
      // DX-200: una cita en curso (paciente en la clínica) también se ve afectada.
      status: {
        in: [
          AppointmentStatus.SCHEDULED,
          AppointmentStatus.CONFIRMED,
          ...IN_CLINIC_STATUSES,
        ],
      },
      start: { lt: scope.end },
      end: { gt: scope.start },
    };
    return this.prisma.runWithTenant(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.appointment.findMany({
          where,
          orderBy: [{ start: 'asc' }, { id: 'asc' }],
          take: limit,
          select: {
            id: true,
            locationId: true,
            providerId: true,
            start: true,
            end: true,
            status: true,
            patient: { select: { firstName: true, lastName: true } },
          },
        }),
        tx.appointment.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          locationId: r.locationId,
          providerId: r.providerId,
          start: r.start,
          end: r.end,
          status: r.status,
          patientFirstName: r.patient.firstName,
          patientLastName: r.patient.lastName,
        })),
        total,
      };
    });
  }
}
