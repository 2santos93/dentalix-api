import { Injectable } from '@nestjs/common';
import { CollectionOutcome } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { BalanceReminderPolicy } from '../domain/balance-reminders';
import type { BalanceRemindersRepository } from '../domain/ports/balance-reminders-repository.port';

interface PolicyRow {
  balanceReminderDays: number[];
  balanceReminderMaxNotices: number;
  balanceReminderMinGapDays: number;
}

const POLICY_SELECT = {
  balanceReminderDays: true,
  balanceReminderMaxNotices: true,
  balanceReminderMinGapDays: true,
} as const;

function toPolicy(row: PolicyRow): BalanceReminderPolicy {
  return {
    days: [...row.balanceReminderDays],
    maxNotices: row.balanceReminderMaxNotices,
    minGapDays: row.balanceReminderMinGapDays,
  };
}

/**
 * «Por avisar hoy» (DX-146): la política (columnas de `tenants`, siempre por
 * el id de la clínica del contexto), la baja de los avisos (DX-128) y los
 * avisos ya dados (notas REMINDER_SENT, append-only).
 */
@Injectable()
export class PrismaBalanceRemindersRepository implements BalanceRemindersRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async policy(): Promise<BalanceReminderPolicy> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: POLICY_SELECT,
    });
    return toPolicy(tenant);
  }

  setPolicy(
    next: BalanceReminderPolicy,
    ctx: AuditRequestContext,
  ): Promise<{ before: BalanceReminderPolicy; after: BalanceReminderPolicy }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada, escritura y evento en la misma
    // transacción (con la clínica en el contexto de RLS: audit_events la
    // exige), como los ajustes de la oferta de hueco (DX-448).
    return this.prisma.runWithTenant(id, async (tx) => {
      const [locked] = await tx.$queryRaw<PolicyRow[]>`
        SELECT "balanceReminderDays", "balanceReminderMaxNotices",
               "balanceReminderMinGapDays"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toPolicy(locked);
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          balanceReminderDays: next.days,
          balanceReminderMaxNotices: next.maxNotices,
          balanceReminderMinGapDays: next.minGapDays,
        },
        select: POLICY_SELECT,
      });
      const after = toPolicy(tenant);
      // Ajuste de TODA la clínica: sin la sede activa de quien lo cambió
      // (DX-363). Si nada cambió, `configAuditEvent` no da evento.
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'BALANCE_REMINDER_POLICY',
        locationId: null,
        before: { ...before },
        after: { ...after },
      });
      if (event) await writeAuditEvent(tx, event);
      return { before, after };
    });
  }

  async patientsOptedOut(patientIds: readonly string[]): Promise<Set<string>> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return new Set();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patient.findMany({
        where: {
          tenantId,
          id: { in: [...patientIds] },
          reminderOptOutAt: { not: null },
        },
        select: { id: true },
      }),
    );
    return new Set(rows.map((r) => r.id));
  }

  async noticesOf(patientIds: readonly string[]): Promise<Map<string, Date[]>> {
    const tenantId = this.tenantId();
    const out = new Map<string, Date[]>();
    if (patientIds.length === 0) return out;
    // Por collection_notes_tenant_patient_created_idx; pocas filas por
    // paciente (como mucho un aviso por día y por deuda).
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.collectionNote.findMany({
        where: {
          tenantId,
          patientId: { in: [...patientIds] },
          outcome: CollectionOutcome.REMINDER_SENT,
        },
        select: { patientId: true, createdAt: true },
      }),
    );
    for (const row of rows) {
      const list = out.get(row.patientId) ?? [];
      list.push(row.createdAt);
      out.set(row.patientId, list);
    }
    return out;
  }
}
