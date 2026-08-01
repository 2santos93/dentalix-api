import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
  ListAppointmentsByRangeParams,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';

type PrismaAppointment = Prisma.AppointmentGetPayload<Record<string, never>>;

function mapToEntity(appointment: PrismaAppointment): Appointment {
  return {
    id: appointment.id,
    tenantId: appointment.tenantId,
    patientId: appointment.patientId,
    providerId: appointment.providerId,
    start: appointment.start,
    end: appointment.end,
    status: appointment.status,
    reason: appointment.reason,
    notes: appointment.notes,
    createdById: appointment.createdById,
    createdAt: appointment.createdAt,
    updatedAt: appointment.updatedAt,
  };
}

@Injectable()
export class PrismaAppointmentRepository implements AppointmentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant`, so the value
   * written always matches the GUC the WITH CHECK policy validates against.
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreateAppointmentRepoInput): Promise<Appointment> {
    const tenantId = this.requireTenantId();
    const appointment = await this.prisma.runWithTenant(async (tx) => {
      return tx.appointment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          providerId: input.providerId,
          start: input.start,
          end: input.end,
          reason: input.reason,
          notes: input.notes,
          createdById: input.createdById,
        },
      });
    });
    return mapToEntity(appointment);
  }

  async findById(id: string): Promise<Appointment | null> {
    const appointment = await this.prisma.runWithTenant(async (tx) => {
      return tx.appointment.findFirst({
        where: { id, deletedAt: null },
      });
    });
    return appointment ? mapToEntity(appointment) : null;
  }

  async listByRange(
    params: ListAppointmentsByRangeParams,
  ): Promise<Appointment[]> {
    const where: Prisma.AppointmentWhereInput = {
      deletedAt: null,
      start: { gte: params.from, lt: params.to },
      ...(params.providerId ? { providerId: params.providerId } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
      });
      return appointments.map(mapToEntity);
    });
  }

  async findOverlapping(
    providerId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    const where: Prisma.AppointmentWhereInput = {
      providerId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      // Half-open interval overlap: [start,end) overlaps [s2,e2) iff
      // start < e2 AND s2 < end — i.e. this appointment's start is before
      // the other's end, AND this appointment's end is after the other's
      // start. Back-to-back (adjacent) appointments where one's end equals
      // the other's start do NOT satisfy both conditions, so they don't
      // overlap.
      start: { lt: end },
      end: { gt: start },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
      });
      return appointments.map(mapToEntity);
    });
  }

  async findOverlappingForPatient(
    patientId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    // Mismo criterio de solape medio-abierto que `findOverlapping` (ver el
    // detalle allí): dos citas contiguas no se solapan. Solo cambia el eje:
    // paciente en vez de profesional.
    const where: Prisma.AppointmentWhereInput = {
      patientId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      start: { lt: end },
      end: { gt: start },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
      });
      return appointments.map(mapToEntity);
    });
  }

  async update(
    id: string,
    patch: UpdateAppointmentRepoInput,
  ): Promise<Appointment> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.appointment.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Appointment not found');
      }

      const appointment = await tx.appointment.update({
        where: { id },
        data: patch,
      });
      return mapToEntity(appointment);
    });
  }
}
