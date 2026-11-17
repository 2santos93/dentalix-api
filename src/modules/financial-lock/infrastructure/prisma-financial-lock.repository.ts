import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { FinancialLockSettings } from '../domain/financial-lock';
import type { FinancialLockOverrideView } from '../domain/financial-lock-settings';
import type { FinancialLockRepository } from '../domain/ports/financial-lock-repository.port';
import { readFinancialLock } from './financial-lock-tx';

const civil = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string | null): Date | null =>
  day === null ? null : new Date(`${day}T00:00:00.000Z`);

/** Lo que va a la auditoría: los tres ajustes, sin nada más. */
function forAudit(settings: FinancialLockSettings) {
  return {
    financialLockDate: settings.lockDate,
    financialLockDays: settings.lockDays,
    financialLockAdminExempt: settings.adminExempt,
  };
}

/**
 * DX-091. `tenants` es global (sin RLS): siempre por el id del contexto,
 * nunca por uno que llegue en la petición. `financial_lock_overrides` sí tiene
 * RLS y se lee dentro de `runWithTenant`.
 */
@Injectable()
export class PrismaFinancialLockRepository implements FinancialLockRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  get(): Promise<FinancialLockSettings> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) => readFinancialLock(tx, tenantId));
  }

  siteTimeZone(): Promise<string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      return (await resolveLocationTimeZones(tx, tenantId, [locationId]))(
        locationId,
      );
    });
  }

  listOverrides(limit: number): Promise<FinancialLockOverrideView[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.financialLockOverride.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: { location: { select: { id: true, name: true } } },
      });
      // El nombre visible de quien lo hizo, como el estado de cuenta (puntero
      // suave: un miembro que ya no está sale sin nombre).
      const members =
        rows.length === 0
          ? []
          : await tx.clinicMembership.findMany({
              where: {
                tenantId,
                userId: { in: [...new Set(rows.map((r) => r.actorUserId))] },
              },
              select: { userId: true, user: { select: { fullName: true } } },
            });
      const nameOf = new Map(members.map((m) => [m.userId, m.user.fullName]));
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        operation: row.operation,
        businessDate: civil(row.businessDate),
        lockedThrough: civil(row.lockedThrough),
        reason: row.reason,
        actor: {
          userId: row.actorUserId,
          name: nameOf.get(row.actorUserId) ?? null,
        },
        paymentId: row.paymentId,
        paymentPlanId: row.paymentPlanId,
        location: row.location,
      }));
    });
  }

  update(
    prepare: (current: FinancialLockSettings) => FinancialLockSettings,
    ctx: AuditRequestContext,
  ): Promise<FinancialLockSettings> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La fila bloqueada: dos cambios simultáneos se ordenan y cada uno
      // audita su antes real.
      await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await readFinancialLock(tx, id);
      const next = prepare(before);
      await tx.tenant.update({
        where: { id },
        data: {
          financialLockDate: asDate(next.lockDate),
          financialLockDays: next.lockDays,
          financialLockAdminExempt: next.adminExempt,
        },
        select: { id: true },
      });
      const after = await readFinancialLock(tx, id);
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'FINANCIAL_LOCK',
        before: forAudit(before),
        after: forAudit(after),
      });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }
}
