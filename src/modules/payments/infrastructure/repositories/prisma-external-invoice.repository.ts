import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type {
  ExternalInvoiceRepository,
  SetExternalInvoiceOutcome,
} from '../../domain/ports/external-invoice-repository.port';

interface PaymentRow {
  id: string;
  locationId: string;
  splitId: string | null;
  deletedAt: Date | null;
  externalInvoiceNumber: string | null;
}

/**
 * DX-515: el nº de la factura fiscal que la clínica emitió FUERA de Dentalix
 * para un abono. Bajo RLS (`runWithTenant`): un abono de otra clínica no se ve
 * (404). Solo cambia `payments.externalInvoiceNumber`; el recibo y su foto no
 * se tocan (append-only).
 */
@Injectable()
export class PrismaExternalInvoiceRepository implements ExternalInvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  set(
    paymentId: string,
    value: string | null,
    ctx: AuditRequestContext,
  ): Promise<SetExternalInvoiceOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const [target] = await tx.$queryRaw<PaymentRow[]>`
        SELECT "id", "locationId", "splitId", "deletedAt", "externalInvoiceNumber"
          FROM "payments" WHERE "id" = ${paymentId}::uuid`;
      if (!target) return { kind: 'not-found' };
      if (target.deletedAt !== null) return { kind: 'voided' };

      // DX-390: un cobro dividido tiene un solo recibo, y por tanto una sola
      // factura: el nº va en todas sus líneas vivas. Se bloquean en el orden
      // de las líneas, el mismo que usa la anulación (sin interbloqueos).
      const lines = target.splitId
        ? await tx.$queryRaw<PaymentRow[]>`
            SELECT "id", "locationId", "splitId", "deletedAt", "externalInvoiceNumber"
              FROM "payments"
             WHERE "splitId" = ${target.splitId}::uuid AND "deletedAt" IS NULL
             ORDER BY "splitLine"
             FOR UPDATE`
        : await tx.$queryRaw<PaymentRow[]>`
            SELECT "id", "locationId", "splitId", "deletedAt", "externalInvoiceNumber"
              FROM "payments"
             WHERE "id" = ${paymentId}::uuid AND "deletedAt" IS NULL
             FOR UPDATE`;
      const locked = lines.find((line) => line.id === paymentId);
      // Anulado entre la lectura y el bloqueo.
      if (!locked) return { kind: 'voided' };
      const paymentIds = lines.map((line) => line.id);

      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, deletedAt: null },
        data: { externalInvoiceNumber: value },
      });

      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'PAYMENT',
        resourceId: paymentId,
        locationId: locked.locationId,
        reason: 'EXTERNAL_INVOICE_NUMBER',
        before: { externalInvoiceNumber: locked.externalInvoiceNumber },
        after: { externalInvoiceNumber: value },
      });
      // Sin cambio, sin evento (configAuditEvent devuelve null).
      if (event) {
        await writeAuditEvent(tx, {
          ...event,
          patient: { kind: 'payment', id: paymentId },
        });
      }
      return {
        kind: 'saved',
        result: { paymentId, externalInvoiceNumber: value, paymentIds },
      };
    });
  }
}
