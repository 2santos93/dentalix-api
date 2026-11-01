import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { lockRow } from '../../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { AppointmentType } from '../../domain/entities/appointment-type.entity';
import {
  AppointmentTypeRepository,
  CreateAppointmentTypeRepoInput,
  UpdateAppointmentTypeRepoInput,
} from '../../domain/ports/appointment-type-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { appointmentTypeSnapshot } from '../../domain/appointment-type-audit';

const AUDIT_TARGET = { resourceType: 'APPOINTMENT_TYPE' } as const;

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
    isUrgent: row.isUrgent,
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
    audit: AuditRequestContext,
  ): Promise<AppointmentType> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const created = mapToEntity(
          await tx.appointmentType.create({
            data: {
              tenantId,
              name: input.name,
              durationMinutes: input.durationMinutes,
              color: input.color,
              active: input.active,
              isUrgent: input.isUrgent ?? false,
              createdById: input.createdById,
              updatedById: input.createdById,
            },
          }),
        );
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            ...AUDIT_TARGET,
            action: 'CREATE',
            resourceId: created.id,
            reason: 'APPOINTMENT_TYPE_CREATED',
            after: appointmentTypeSnapshot(created),
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateName);
  }

  /** Por `id` bajo RLS; el use-case ya comprobó que existe y está vivo. */
  async update(
    id: string,
    input: UpdateAppointmentTypeRepoInput,
    audit: AuditRequestContext,
  ): Promise<AppointmentType> {
    return this.prisma
      .runWithTenant(async (tx) => {
        // DX-360: el antes, con la fila bloqueada hasta el final.
        await lockRow(tx, 'appointment_types', id);
        const before = mapToEntity(
          await tx.appointmentType.findUniqueOrThrow({ where: { id } }),
        );
        const after = mapToEntity(
          await tx.appointmentType.update({
            where: { id },
            data: {
              name: input.name,
              durationMinutes: input.durationMinutes,
              color: input.color,
              active: input.active,
              isUrgent: input.isUrgent,
              updatedById: input.updatedById,
            },
          }),
        );
        const event = configAuditEvent(audit, {
          ...AUDIT_TARGET,
          action: 'UPDATE',
          resourceId: id,
          reason: 'APPOINTMENT_TYPE_UPDATED',
          before: appointmentTypeSnapshot(before),
          after: appointmentTypeSnapshot(after),
        });
        if (event) await writeAuditEvent(tx, event);
        return after;
      })
      .catch(rethrowDuplicateName);
  }

  async softDelete(id: string, audit: AuditRequestContext): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      await lockRow(tx, 'appointment_types', id);
      const before = mapToEntity(
        await tx.appointmentType.findUniqueOrThrow({ where: { id } }),
      );
      await tx.appointmentType.update({
        where: { id },
        data: {
          active: false,
          deletedAt: new Date(),
          updatedById: audit.actor.userId,
        },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          ...AUDIT_TARGET,
          action: 'DELETE',
          resourceId: id,
          reason: 'APPOINTMENT_TYPE_DELETED',
          before: appointmentTypeSnapshot(before),
        }),
      );
    });
  }
}
