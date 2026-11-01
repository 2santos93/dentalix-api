import { ConflictException, Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockRow } from '../../../shared/prisma/lock-row';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  ClinicPaymentMethodEntity,
  PaymentMethodAdjustmentEntity,
} from '../domain/payment-method.entity';
import type {
  PaymentAdjustmentWriteInput,
  PaymentAdjustmentWriteResult,
  PaymentMethodRepository,
  PaymentMethodWriteInput,
} from '../domain/ports/payment-method-repository.port';
import { paymentAdjustmentSnapshot } from '../domain/payment-adjustment-audit';
import { ADJUSTMENTS_PER_METHOD_MAX } from '../domain/payment-adjustments';
import {
  DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE,
  INITIAL_PAYMENT_METHODS,
} from '../domain/payment-method-rules';

// DX-516: cada medio con sus ajustes, en el orden en que se crearon.
const WITH_ADJUSTMENTS = {
  adjustments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ClinicPaymentMethodInclude;

type PrismaPaymentMethod = Prisma.ClinicPaymentMethodGetPayload<{
  include: typeof WITH_ADJUSTMENTS;
}>;
type PrismaAdjustment = Prisma.PaymentMethodAdjustmentGetPayload<
  Record<string, never>
>;

function mapAdjustment(row: PrismaAdjustment): PaymentMethodAdjustmentEntity {
  return {
    id: row.id,
    paymentMethodId: row.paymentMethodId,
    type: row.type,
    label: row.label,
    calculation: row.calculation,
    percent: row.percent?.toNumber() ?? null,
    fixedAmount: row.fixedAmount?.toNumber() ?? null,
    fixedCurrency: row.fixedCurrency,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapToEntity(row: PrismaPaymentMethod): ClinicPaymentMethodEntity {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    kind: row.kind,
    active: row.active,
    requiresReference: row.requiresReference,
    legacyMethod: row.legacyMethod,
    adjustments: row.adjustments.map(mapAdjustment),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Dos altas a la vez con el mismo nombre: el único (tenantId, name) decide. */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE);
  }
  throw error;
}

/**
 * Los 4 medios iniciales de una clínica recién creada (DX-377), en la
 * transacción del alta y con el GUC de tenant ya fijado (RLS WITH CHECK).
 */
export async function seedInitialPaymentMethods(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.clinicPaymentMethod.createMany({
    data: INITIAL_PAYMENT_METHODS.map((m) => ({ ...m, tenantId })),
    skipDuplicates: true,
  });
}

@Injectable()
export class PrismaPaymentMethodRepository implements PaymentMethodRepository {
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

  list(params: {
    includeInactive: boolean;
  }): Promise<ClinicPaymentMethodEntity[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicPaymentMethod.findMany({
        where: params.includeInactive ? {} : { active: true },
        include: WITH_ADJUSTMENTS,
        orderBy: { name: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<ClinicPaymentMethodEntity | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({
        where: { id },
        include: WITH_ADJUSTMENTS,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  findByLegacyMethod(
    method: PaymentMethod,
  ): Promise<ClinicPaymentMethodEntity | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({
        where: { legacyMethod: method },
        include: WITH_ADJUSTMENTS,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  nameTaken(name: string, exceptId?: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({
        where: {
          name: { equals: name, mode: 'insensitive' },
          ...(exceptId ? { NOT: { id: exceptId } } : {}),
        },
        select: { id: true },
      });
      return row !== null;
    });
  }

  async create(
    input: Required<PaymentMethodWriteInput>,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) =>
        mapToEntity(
          await tx.clinicPaymentMethod.create({
            data: {
              ...input,
              tenantId,
              createdById: userId,
              updatedById: userId,
            },
            include: WITH_ADJUSTMENTS,
          }),
        ),
      );
    } catch (error) {
      rethrowDuplicateName(error);
    }
  }

  async update(
    id: string,
    input: PaymentMethodWriteInput,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity | null> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const result = await tx.clinicPaymentMethod.updateMany({
          where: { id },
          data: { ...input, updatedById: userId },
        });
        if (result.count === 0) return null;
        const row = await tx.clinicPaymentMethod.findFirst({
          where: { id },
          include: WITH_ADJUSTMENTS,
        });
        return row ? mapToEntity(row) : null;
      });
    } catch (error) {
      rethrowDuplicateName(error);
    }
  }

  /**
   * DX-516: el medio bloqueado (FOR NO KEY UPDATE: los abonos que lo
   * referencian por FK no esperan) serializa las altas y cambios de sus
   * ajustes, así el tope de activos y la etiqueta única no se saltan con dos
   * peticiones a la vez. El evento de configuración va en la misma
   * transacción (DX-360).
   */
  createAdjustment(
    paymentMethodId: string,
    input: PaymentAdjustmentWriteInput,
    audit: AuditRequestContext,
  ): Promise<PaymentAdjustmentWriteResult> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      if (
        !(await lockRow(
          tx,
          'payment_methods',
          paymentMethodId,
          'NO KEY UPDATE',
        ))
      ) {
        return { ok: false, reason: 'METHOD_NOT_FOUND' };
      }
      const siblings = await tx.paymentMethodAdjustment.findMany({
        where: { paymentMethodId },
        select: { id: true, label: true, active: true },
      });
      const problem = adjustmentConflict(siblings, input, null);
      if (problem) return { ok: false, reason: problem };
      const row = await tx.paymentMethodAdjustment.create({
        data: {
          ...input,
          tenantId,
          paymentMethodId,
          createdById: audit.actor.userId,
          updatedById: audit.actor.userId,
        },
      });
      const adjustment = mapAdjustment(row);
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'CREATE',
          resourceType: 'PAYMENT_METHOD',
          resourceId: paymentMethodId,
          reason: 'PAYMENT_METHOD_ADJUSTMENT_CREATED',
          after: paymentAdjustmentSnapshot(adjustment),
        }),
      );
      return { ok: true, adjustment };
    });
  }

  updateAdjustment(
    paymentMethodId: string,
    adjustmentId: string,
    input: PaymentAdjustmentWriteInput,
    audit: AuditRequestContext,
  ): Promise<PaymentAdjustmentWriteResult> {
    return this.prisma.runWithTenant(async (tx) => {
      if (
        !(await lockRow(
          tx,
          'payment_methods',
          paymentMethodId,
          'NO KEY UPDATE',
        ))
      ) {
        return { ok: false, reason: 'METHOD_NOT_FOUND' };
      }
      const siblings = await tx.paymentMethodAdjustment.findMany({
        where: { paymentMethodId },
      });
      const current = siblings.find((s) => s.id === adjustmentId);
      if (!current) return { ok: false, reason: 'NOT_FOUND' };
      const problem = adjustmentConflict(siblings, input, adjustmentId);
      if (problem) return { ok: false, reason: problem };
      const row = await tx.paymentMethodAdjustment.update({
        where: { id: adjustmentId },
        data: { ...input, updatedById: audit.actor.userId },
      });
      const adjustment = mapAdjustment(row);
      const event = configAuditEvent(audit, {
        action: 'UPDATE',
        resourceType: 'PAYMENT_METHOD',
        resourceId: paymentMethodId,
        reason: 'PAYMENT_METHOD_ADJUSTMENT_UPDATED',
        before: paymentAdjustmentSnapshot(mapAdjustment(current)),
        after: paymentAdjustmentSnapshot(adjustment),
      });
      if (event) await writeAuditEvent(tx, event);
      return { ok: true, adjustment };
    });
  }
}

/**
 * DX-516: la etiqueta es única en el medio (sin mayúsculas) y el medio admite
 * como mucho `ADJUSTMENTS_PER_METHOD_MAX` ajustes activos.
 */
function adjustmentConflict(
  siblings: readonly { id: string; label: string; active: boolean }[],
  input: PaymentAdjustmentWriteInput,
  exceptId: string | null,
): 'LABEL_TAKEN' | 'LIMIT' | null {
  const others = siblings.filter((s) => s.id !== exceptId);
  const label = input.label.toLocaleLowerCase();
  if (others.some((s) => s.label.toLocaleLowerCase() === label)) {
    return 'LABEL_TAKEN';
  }
  if (
    input.active &&
    others.filter((s) => s.active).length >= ADJUSTMENTS_PER_METHOD_MAX
  ) {
    return 'LIMIT';
  }
  return null;
}
