import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ExpensePayment } from '../../expenses/domain/entities/expense.entity';
import {
  ExpenseCashSession,
  OUTFLOW_VOID_CONFLICT_MESSAGE,
  adjustmentReasonOf,
} from './expense-cash-session';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const CLOSED = '33333333-3333-4333-8333-333333333333';
const VOIDER = '55555555-5555-4555-8555-555555555555';

const payment = { id: 'pago-1' } as ExpensePayment;

/**
 * Transacción falsa de una salida anulada con su caja cerrada: la fila del
 * pago, los bloqueos (sede, estado de la caja, caja de quien anula) y el
 * INSERT del ajuste.
 */
function build(options: { status?: 'OPEN' | 'CLOSED'; target?: string }) {
  const tx = {
    expensePayment: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'pago-1',
          locationId: LOCATION,
          cashSessionId: CLOSED,
          currency: 'COP',
          amount: new Prisma.Decimal('15000.50'),
          voidedAt: new Date(),
        }),
      ),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('"status"::text')) {
        return Promise.resolve([{ status: options.status ?? 'CLOSED' }]);
      }
      if (sql.includes('"openedById"')) {
        return Promise.resolve(options.target ? [{ id: options.target }] : []);
      }
      return Promise.resolve([]); // bloqueo de la sede
    }),
    cashSessionAdjustment: { create: jest.fn(() => Promise.resolve({})) },
  };
  const tenant = new TenantContextService();
  const link = new ExpenseCashSession({} as unknown as PrismaService, tenant);
  const voided = (reason = 'Compra cancelada') =>
    tenant.run(TENANT, () =>
      link.onPaymentVoided(
        tx as unknown as Prisma.TransactionClient,
        payment,
        reason,
        VOIDER,
      ),
    );
  return { tx, voided };
}

describe('anulación de una salida de caja (DX-274)', () => {
  it('el motivo del ajuste cabe en el CHECK de DX-027 (3–300 caracteres)', () => {
    expect(adjustmentReasonOf('  Pago duplicado ')).toBe('Pago duplicado');
    const long = 'ñ'.repeat(500);
    const cut = adjustmentReasonOf(long);
    expect(Array.from(cut)).toHaveLength(300);
    expect(cut.endsWith('…')).toBe(true);
    expect(adjustmentReasonOf('x'.repeat(300))).toBe('x'.repeat(300));
  });

  it('con la caja cerrada: OUTFLOW_VOID positivo con importe, moneda y origen de la fila del pago', async () => {
    const { tx, voided } = build({ target: 'caja-de-quien-anula' });
    await voided();
    expect(tx.expensePayment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pago-1', tenantId: TENANT } }),
    );
    expect(tx.cashSessionAdjustment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        locationId: LOCATION,
        sessionId: 'caja-de-quien-anula',
        kind: 'OUTFLOW_VOID',
        expensePaymentId: 'pago-1',
        originalSessionId: CLOSED,
        currency: 'COP',
        method: 'CASH',
        amount: new Prisma.Decimal('15000.50'),
        reason: 'Compra cancelada',
        createdById: VOIDER,
      }) as unknown,
    });
  });

  it('con la caja aún abierta no hay ajuste', async () => {
    const { tx, voided } = build({ status: 'OPEN' });
    await voided();
    expect(tx.cashSessionAdjustment.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'el único (P2002: ya anulada en caja)',
      new Prisma.PrismaClientKnownRequestError('único', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    ],
    [
      'el trigger (42501: caja no abierta)',
      new Prisma.PrismaClientUnknownRequestError(
        'PostgresError { code: "42501", message: "x" }',
        { clientVersion: 'test' },
      ),
    ],
    [
      'la FK (P2003)',
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    ],
  ])('%s es un 409 en español, nunca un 500', async (_name, error) => {
    const { tx, voided } = build({});
    tx.cashSessionAdjustment.create.mockRejectedValue(error);
    await expect(voided()).rejects.toEqual(
      new ConflictException(OUTFLOW_VOID_CONFLICT_MESSAGE),
    );
  });

  it('cualquier otro error sigue su camino', async () => {
    const { tx, voided } = build({});
    const error = new Error('conexión perdida');
    tx.cashSessionAdjustment.create.mockRejectedValue(error);
    await expect(voided()).rejects.toBe(error);
  });
});
