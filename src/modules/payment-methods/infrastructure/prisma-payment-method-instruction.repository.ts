import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockRow } from '../../../shared/prisma/lock-row';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  PAYMENT_INSTRUCTION_FIELDS,
  type PaymentInstructionFields,
  type PaymentMethodInstruction,
} from '../domain/payment-method-instructions';
import type {
  InstructionWriteResult,
  PaymentMethodInstructionRepository,
} from '../domain/ports/payment-method-instruction-repository.port';

type Row = Prisma.PaymentMethodInstructionGetPayload<Record<string, never>>;

function mapInstruction(row: Row): PaymentMethodInstruction {
  return {
    id: row.id,
    paymentMethodId: row.paymentMethodId,
    locationId: row.locationId,
    holderName: row.holderName,
    holderId: row.holderId,
    bankName: row.bankName,
    accountNumber: row.accountNumber,
    phone: row.phone,
    email: row.email,
    note: row.note,
    updatedAt: row.updatedAt,
  };
}

/**
 * La foto para la auditoría (DX-360): la sede y los campos; sus VALORES no se
 * guardan (cuentas y teléfonos de cobro), solo cuáles cambiaron.
 */
function snapshot(row: PaymentMethodInstruction) {
  return {
    locationId: row.locationId,
    ...Object.fromEntries(PAYMENT_INSTRUCTION_FIELDS.map((f) => [f, row[f]])),
  };
}

/** La clínica primero y luego cada sede, siempre en el mismo orden. */
const ORDER = [
  { locationId: { sort: 'asc', nulls: 'first' } },
  { createdAt: 'asc' },
] satisfies Prisma.PaymentMethodInstructionOrderByWithRelationInput[];

@Injectable()
export class PrismaPaymentMethodInstructionRepository implements PaymentMethodInstructionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  listByMethod(
    paymentMethodId: string,
  ): Promise<PaymentMethodInstruction[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const method = await tx.clinicPaymentMethod.findFirst({
        where: { id: paymentMethodId },
        select: { id: true },
      });
      if (!method) return null;
      const rows = await tx.paymentMethodInstruction.findMany({
        where: { paymentMethodId },
        orderBy: ORDER,
      });
      return rows.map(mapInstruction);
    });
  }

  listAll(): Promise<PaymentMethodInstruction[]> {
    return this.prisma.runWithTenant(async (tx) =>
      (await tx.paymentMethodInstruction.findMany({ orderBy: ORDER })).map(
        mapInstruction,
      ),
    );
  }

  upsert(
    paymentMethodId: string,
    locationId: string | null,
    fields: PaymentInstructionFields,
    audit: AuditRequestContext,
  ): Promise<InstructionWriteResult> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // El medio bloqueado serializa dos guardados a la vez de la misma sede
      // (sin él, los dos verían «no hay fila» y el segundo INSERT chocaría
      // con el único). FOR NO KEY UPDATE: los abonos que lo referencian no
      // esperan.
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
      if (locationId !== null) {
        const location = await tx.location.findFirst({
          where: { id: locationId, deletedAt: null },
          select: { id: true },
        });
        if (!location) return { ok: false, reason: 'LOCATION_NOT_FOUND' };
      }
      const current = await tx.paymentMethodInstruction.findFirst({
        where: { paymentMethodId, locationId },
      });
      const row = current
        ? await tx.paymentMethodInstruction.update({
            where: { id: current.id },
            data: { ...fields, updatedById: audit.actor.userId },
          })
        : await tx.paymentMethodInstruction.create({
            data: {
              ...fields,
              tenantId,
              paymentMethodId,
              locationId,
              createdById: audit.actor.userId,
              updatedById: audit.actor.userId,
            },
          });
      const instruction = mapInstruction(row);
      const hiddenFields = PAYMENT_INSTRUCTION_FIELDS;
      const event = current
        ? configAuditEvent(audit, {
            action: 'UPDATE',
            resourceType: 'PAYMENT_METHOD',
            resourceId: paymentMethodId,
            reason: 'PAYMENT_METHOD_INSTRUCTIONS_UPDATED',
            locationId,
            hiddenFields,
            before: snapshot(mapInstruction(current)),
            after: snapshot(instruction),
          })
        : configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'PAYMENT_METHOD',
            resourceId: paymentMethodId,
            reason: 'PAYMENT_METHOD_INSTRUCTIONS_CREATED',
            locationId,
            hiddenFields,
            after: snapshot(instruction),
          });
      if (event) await writeAuditEvent(tx, event);
      return { ok: true, instruction };
    });
  }

  remove(
    paymentMethodId: string,
    instructionId: string,
    audit: AuditRequestContext,
  ): Promise<PaymentMethodInstruction | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const current = await tx.paymentMethodInstruction.findFirst({
        where: { id: instructionId, paymentMethodId },
      });
      if (!current) return null;
      // Excepción justificada al borrado blando: configuración de cobro sin
      // datos de pacientes y sin nada que la referencie (el enlace muestra la
      // que rige al abrirse). Quitar la de una sede vuelve a la de la
      // clínica; el cambio queda en audit_events (allowlist de
      // no-hard-delete).
      // eslint-disable-next-line no-restricted-syntax
      await tx.paymentMethodInstruction.delete({ where: { id: current.id } });
      const removed = mapInstruction(current);
      const event = configAuditEvent(audit, {
        action: 'DELETE',
        resourceType: 'PAYMENT_METHOD',
        resourceId: paymentMethodId,
        reason: 'PAYMENT_METHOD_INSTRUCTIONS_REMOVED',
        locationId: current.locationId,
        hiddenFields: PAYMENT_INSTRUCTION_FIELDS,
        before: snapshot(removed),
      });
      if (event) await writeAuditEvent(tx, event);
      return removed;
    });
  }
}
