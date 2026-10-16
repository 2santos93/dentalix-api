import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateDentitionEventItem,
  DentitionEventRepository,
} from '../../domain/ports/dentition-event-repository.port';
import type { DentitionEvent } from '../../domain/dentition';

type PrismaDentitionEvent = Prisma.PatientDentitionEventGetPayload<
  Record<string, never>
>;

function mapEvent(row: PrismaDentitionEvent): DentitionEvent {
  return {
    id: row.id,
    position: row.position,
    dentition: row.dentition,
    reason: row.reason,
    recordedAt: row.recordedAt,
    performedById: row.performedById,
  };
}

/** Orden cronológico estable (sirve el índice patient_dentition_events_patient_recorded_idx). */
const EVENT_ORDER: Prisma.PatientDentitionEventOrderByWithRelationInput[] = [
  { recordedAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class PrismaDentitionEventRepository implements DentitionEventRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async listByPatient(patientId: string): Promise<DentitionEvent[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientDentitionEvent.findMany({
        where: { patientId },
        orderBy: EVENT_ORDER,
      }),
    );
    return rows.map(mapEvent);
  }

  /**
   * Append-only: INSERTs en una sola transacción de runWithTenant (todos o
   * ninguno). Misma hora para todo el lote, así el orden (recordedAt, id) no
   * depende de cuánto tarde cada INSERT; `createdAt` lo pone el trigger.
   */
  async createMany(
    patientId: string,
    items: readonly CreateDentitionEventItem[],
    performedById: string,
  ): Promise<DentitionEvent[]> {
    const tenantId = this.requireTenantId();
    const recordedAt = new Date();
    const rows = await this.prisma.runWithTenant(async (tx) => {
      const created: PrismaDentitionEvent[] = [];
      for (const item of items) {
        created.push(
          await tx.patientDentitionEvent.create({
            data: {
              tenantId,
              patientId,
              position: item.position,
              dentition: item.dentition,
              reason: item.reason,
              recordedAt,
              performedById,
            },
          }),
        );
      }
      return created;
    });
    return rows.map(mapEvent);
  }
}
