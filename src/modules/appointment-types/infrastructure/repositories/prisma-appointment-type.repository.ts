import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { AppointmentType } from '../../domain/entities/appointment-type.entity';
import {
  AppointmentTypeRepository,
  CreateAppointmentTypeRepoInput,
  UpdateAppointmentTypeRepoInput,
} from '../../domain/ports/appointment-type-repository.port';

type PrismaAppointmentType = Prisma.AppointmentTypeGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaAppointmentType): AppointmentType {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    durationMinutes: row.durationMinutes,
    color: row.color,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const DUPLICATE_APPOINTMENT_TYPE_MESSAGE =
  'Ya existe un tipo de cita con ese nombre.';

/**
 * El único UNIQUE que una escritura de tipos puede violar es (tenantId, name)
 * entre los vivos. Se traduce aquí porque, bajo RLS, Prisma no informa
 * `meta.target` y el filtro global no sabría qué mensaje dar.
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_APPOINTMENT_TYPE_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaAppointmentTypeRepository implements AppointmentTypeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  list(params: { includeInactive: boolean }): Promise<AppointmentType[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.appointmentType.findMany({
        where: {
          deletedAt: null,
          ...(params.includeInactive ? {} : { active: true }),
        },
        orderBy: { name: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<AppointmentType | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointmentType.findFirst({
        where: { id, deletedAt: null },
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(
    input: CreateAppointmentTypeRepoInput,
  ): Promise<AppointmentType> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.appointmentType.create({
          data: {
            tenantId,
            name: input.name,
            durationMinutes: input.durationMinutes,
            color: input.color,
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }

  /** Por `id` bajo RLS; el use-case ya comprobó que existe y está vivo. */
  async update(
    id: string,
    input: UpdateAppointmentTypeRepoInput,
  ): Promise<AppointmentType> {
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.appointmentType.update({
          where: { id },
          data: {
            name: input.name,
            durationMinutes: input.durationMinutes,
            color: input.color,
            active: input.active,
            updatedById: input.updatedById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }

  async softDelete(id: string, deletedById?: string): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.appointmentType.update({
        where: { id },
        data: {
          active: false,
          deletedAt: new Date(),
          updatedById: deletedById,
        },
      }),
    );
  }
}
