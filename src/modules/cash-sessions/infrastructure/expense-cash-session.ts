import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prismaRuleCode } from '../../../shared/prisma/prisma-exception.filter';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ExpensePayment } from '../../expenses/domain/entities/expense.entity';
import { OPEN_CASH_SESSION_REQUIRED_MESSAGE } from '../../expenses/domain/expense-rules';
import type {
  ExpenseCashContext,
  ExpenseCashLink,
} from '../../expenses/domain/ports/expense-cash-link.port';
import { CASH_REASON_MAX } from '../domain/cash-session.entity';
import {
  lockCashAdjustmentAssignment,
  lockedSessionStatus,
  lockOpenSessionOf,
} from './payment-cash-session';

export const OUTFLOW_VOID_CONFLICT_MESSAGE =
  'La caja cambió mientras se anulaba la salida: vuelve a intentarlo.';

/**
 * El motivo de un ajuste admite 3–300 caracteres (CHECK de DX-027) y el de una
 * anulación de gasto hasta 500: el completo queda en el pago; aquí se recorta.
 */
export function adjustmentReasonOf(reason: string): string {
  const chars = Array.from(reason.trim());
  return chars.length <= CASH_REASON_MAX
    ? chars.join('')
    : `${chars.slice(0, CASH_REASON_MAX - 1).join('')}…`;
}

/**
 * Salidas de caja menor (DX-274, R1/R5): lo que la caja por turno hace DENTRO
 * de las transacciones de los pagos de gastos, como `payment-cash-session.ts`
 * con los abonos. Implementa el puerto del módulo de gastos; `ExpensesModule`
 * importa `CashSessionsModule` (nunca al revés).
 */
@Injectable()
export class ExpenseCashSession implements ExpenseCashLink {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * La caja abierta de quien paga en la sede del gasto, con `FOR SHARE`: un
   * cierre simultáneo (FOR UPDATE) espera a que la salida entre, o la salida
   * ve la caja cerrada y es un 409. Nunca entra en una caja cerrada.
   */
  async attachToOpenSession(
    tx: Prisma.TransactionClient,
    ctx: ExpenseCashContext,
  ): Promise<string> {
    const sessionId = await lockOpenSessionOf(
      tx,
      ctx.tenantId,
      ctx.locationId,
      ctx.userId,
    );
    if (!sessionId) {
      throw new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE);
    }
    return sessionId;
  }

  async openSessionLocations(
    userId: string,
    locationIds: readonly string[] | undefined,
  ): Promise<string[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.cashSession.findMany({
        where: {
          tenantId: this.tenantId(),
          openedById: userId,
          status: 'OPEN',
          ...(locationIds ? { locationId: { in: [...locationIds] } } : {}),
        },
        select: { locationId: true },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map((row) => row.locationId);
  }

  /**
   * Tras anular un pago de gasto con caja (misma transacción, R5). Si su caja
   * sigue ABIERTA no hace falta nada: deja de restar en el esperado y sale en
   * «Salidas anuladas». Si ya está CERRADA, la caja no cambia (la salida sigue
   * restando allí) y la anulación es un ajuste OUTFLOW_VOID POSITIVO en la caja
   * abierta de quien anula en esa sede, o pendiente de la siguiente que se
   * abra. Copia de `recordVoidAdjustment` (abonos), con el signo contrario.
   *
   * La caja de origen, el importe y la moneda se toman aquí de la fila del
   * pago; desde DX-393 el trigger de ajustes también lo exige (Q3934, 409).
   */
  async onPaymentVoided(
    tx: Prisma.TransactionClient,
    payment: ExpensePayment,
    reason: string,
    by: string,
  ): Promise<void> {
    const tenantId = this.tenantId();
    const row = await tx.expensePayment.findFirst({
      where: { id: payment.id, tenantId },
      select: {
        id: true,
        locationId: true,
        cashSessionId: true,
        currency: true,
        amount: true,
        voidedAt: true,
      },
    });
    if (!row?.cashSessionId) return; // Nunca salió de una caja.
    if (!row.voidedAt) {
      throw new Error('onPaymentVoided: el pago aún no está anulado');
    }
    // Antes de leer el destino (como los VOID): una apertura simultánea en la
    // sede recoge este ajuste pendiente o no lo ve, nunca a medias.
    await lockCashAdjustmentAssignment(tx, tenantId, row.locationId);
    const status = await lockedSessionStatus(tx, tenantId, row.cashSessionId);
    if (status === 'OPEN') return; // Deja de restar en su propia caja.

    const target = await lockOpenSessionOf(tx, tenantId, row.locationId, by);
    try {
      await tx.cashSessionAdjustment.create({
        data: {
          tenantId,
          locationId: row.locationId,
          sessionId: target,
          kind: 'OUTFLOW_VOID',
          expensePaymentId: row.id,
          originalSessionId: row.cashSessionId,
          currency: row.currency,
          method: 'CASH',
          amount: row.amount,
          reason: adjustmentReasonOf(reason),
          createdById: by,
        },
      });
    } catch (error) {
      // La red de los triggers y del único (una anulación por salida): con
      // los bloqueos de arriba no debería pasar; nunca como 500.
      const code = prismaRuleCode(error);
      if (code === '42501' || code === '23503' || code === '23505') {
        throw new ConflictException(OUTFLOW_VOID_CONFLICT_MESSAGE);
      }
      throw error;
    }
  }
}
