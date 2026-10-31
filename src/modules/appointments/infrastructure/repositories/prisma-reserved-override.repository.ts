import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ReservedOverrideRecord,
  ReservedOverrideRepository,
} from '../../domain/ports/reserved-override-repository.port';

@Injectable()
export class PrismaReservedOverrideRepository implements ReservedOverrideRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async record(
    record: ReservedOverrideRecord,
    ctx: AuditRequestContext,
  ): Promise<{ id: string }> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      const saved = await tx.appointmentReservedOverride.create({
        data: {
          tenantId,
          patientId: record.patientId,
          appointmentId: record.appointmentId,
          blockIds: record.blockIds,
          reason: record.reason,
          createdById: ctx.actor.userId,
        },
        select: { id: true },
      });
      await writeAuditEvent(tx, {
        tenantId,
        locationId: record.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: record.action,
        resourceType: 'APPOINTMENT',
        resourceId: record.appointmentId,
        patient: { kind: 'patient', id: record.patientId },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'RESERVED_SLOT_OVERRIDE',
          reservedSlotOverride: {
            overrideId: saved.id,
            blockIds: record.blockIds,
          },
        },
      });
      return saved;
    });
  }
}
