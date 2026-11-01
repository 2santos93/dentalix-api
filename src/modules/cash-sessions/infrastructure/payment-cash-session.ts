import { ConflictException } from '@nestjs/common';
import { Prisma, type PaymentMethod } from '@prisma/client';
import { civilDateIn, civilDayRange } from '../../../shared/time/civil-day';
import { methodBucket } from '../domain/arqueo';
import { collectedAmount } from '../../payment-methods/domain/payment-adjustments';

/*
 * Lo que la caja por turno (DX-027) hace DENTRO de las transacciones de los
 * abonos (PrismaPaymentRepository): asociar el abono a la caja abierta de quien
 * lo registra y apuntar como ajuste lo que llega tarde a una caja cerrada.
 * Funciones sobre la `tx` del abono, como `issuePaymentReceipt`: si fallan, no
 * hay abono ni anulación.
 */

export const CASH_SESSION_REQUIRED_MESSAGE =
  'Esta clínica exige caja abierta para cobrar en efectivo: abre tu caja en esta sede antes de registrar el abono.';

/**
 * Serializa la recogida de pendientes de una sede con su compensación VOID.
 * Se toma ANTES de leer el destino o reclamar pendientes: bloquear solamente
 * LATE_PAYMENT no evita que el UPDATE de apertura conserve una foto anterior
 * a la inserción del VOID. NO KEY UPDATE permite las FK concurrentes de sede.
 */
export async function lockCashAdjustmentAssignment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "locations"
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${locationId}::uuid
     FOR NO KEY UPDATE`;
}

/**
 * La caja abierta del usuario en la sede, bloqueada en modo compartido hasta
 * el COMMIT: un cierre simultáneo (FOR UPDATE) espera a que el abono entre, o
 * el abono ve la caja ya cerrada.
 */
export async function lockOpenSessionOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "cash_sessions"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "locationId" = ${locationId}::uuid
       AND "openedById" = ${userId}::uuid
       AND "status" = 'OPEN'
     FOR SHARE`;
  return row?.id ?? null;
}

/**
 * Estado de una caja, bloqueada en modo compartido hasta el COMMIT (un cierre
 * o una reapertura simultáneos esperan). Una caja que no se ve cuenta como
 * cerrada: nunca se escribe en ella.
 */
export async function lockedSessionStatus(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sessionId: string,
): Promise<'OPEN' | 'CLOSED'> {
  const [session] = await tx.$queryRaw<{ status: 'OPEN' | 'CLOSED' }[]>`
    SELECT "status"::text AS "status" FROM "cash_sessions"
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${sessionId}::uuid
     FOR SHARE`;
  return session?.status ?? 'CLOSED';
}

export interface PaymentCashAssignment {
  /** La caja donde cuenta el abono (`payments.cashSessionId`). */
  cashSessionId: string | null;
  /**
   * Abono con fecha de un día anterior cuya caja (de esa sede) ya se cerró:
   * no entra en ninguna caja directamente; es un ajuste LATE_PAYMENT en la
   * caja abierta de quien lo registra (o pendiente) con enlace a la cerrada.
   */
  late: { sessionId: string | null; originalSessionId: string } | null;
}

/**
 * Decide la caja de un abono que se va a registrar. Con «exigir caja abierta»
 * y sin caja, un abono en EFECTIVO es 409; los demás métodos y la opción
 * desactivada se registran como hasta ahora (sin caja).
 */
export async function assignPaymentToCashSession(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    locationId: string;
    userId: string | undefined;
    method: PaymentMethod | null | undefined;
    paidAt: Date;
    timeZone: string;
    now: Date;
  },
): Promise<PaymentCashAssignment> {
  if (!input.userId) return { cashSessionId: null, late: null };
  const sessionId = await lockOpenSessionOf(
    tx,
    input.tenantId,
    input.locationId,
    input.userId,
  );
  if (!sessionId && input.method === 'CASH') {
    const tenant = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: { cashRequireOpenSession: true },
    });
    if (tenant?.cashRequireOpenSession) {
      throw new ConflictException(CASH_SESSION_REQUIRED_MESSAGE);
    }
  }

  const paidOn = civilDateIn(input.paidAt, input.timeZone);
  if (paidOn < civilDateIn(input.now, input.timeZone)) {
    const day = civilDayRange(paidOn, input.timeZone);
    // La caja cerrada de la sede que cubría ese día (la última en cerrarse).
    const [closed] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "cash_sessions"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "locationId" = ${input.locationId}::uuid
         AND "status" = 'CLOSED'
         AND "openedAt" < ${day.end}
         AND "closedAt" > ${day.start}
       ORDER BY "closedAt" DESC
       LIMIT 1`;
    if (closed) {
      return {
        cashSessionId: null,
        late: { sessionId, originalSessionId: closed.id },
      };
    }
  }
  return { cashSessionId: sessionId, late: null };
}

/**
 * El ajuste del abono tardío, tras insertar el abono (misma transacción).
 * DX-516: `amount` es lo cobrado (importe ± ajustes por medio de pago).
 */
export async function recordLatePaymentAdjustment(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    tenantId: string;
    locationId: string;
    currency: string;
    method: PaymentMethod | null;
    amount: Prisma.Decimal;
    createdById: string;
  },
  late: NonNullable<PaymentCashAssignment['late']>,
): Promise<void> {
  await tx.cashSessionAdjustment.create({
    data: {
      tenantId: payment.tenantId,
      locationId: payment.locationId,
      sessionId: late.sessionId,
      kind: 'LATE_PAYMENT',
      paymentId: payment.id,
      originalSessionId: late.originalSessionId,
      currency: payment.currency,
      method: methodBucket(payment.method),
      amount: payment.amount,
      createdById: payment.createdById,
    },
  });
}

/**
 * Tras anular un abono (misma transacción): si contaba en una caja que ya se
 * cerró, la caja no cambia y la anulación es un ajuste VOID (en negativo) en
 * la caja abierta de quien anula en esa sede, o pendiente. Si contaba en una
 * caja aún abierta, no hace falta nada: deja de contar en su esperado y sale
 * en «Anulados». Un abono tardío anulado se compensa en la caja donde entró
 * su ajuste mientras esté abierta.
 */
export async function recordVoidAdjustment(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; paymentId: string; voidedById: string },
): Promise<void> {
  const payment = await tx.payment.findFirst({
    where: { id: input.paymentId, tenantId: input.tenantId },
    select: {
      id: true,
      locationId: true,
      cashSessionId: true,
      currency: true,
      method: true,
      amount: true,
      // DX-516: la anulación compensa lo cobrado (importe ± ajustes).
      methodAdjustments: { select: { type: true, amount: true } },
    },
  });
  if (!payment) return;

  const statusOf = (sessionId: string) =>
    lockedSessionStatus(tx, input.tenantId, sessionId);
  const actorSession = () =>
    lockOpenSessionOf(tx, input.tenantId, payment.locationId, input.voidedById);

  let targetSessionId: string | null;
  let originalSessionId: string | null = null;
  if (payment.cashSessionId) {
    await lockCashAdjustmentAssignment(tx, input.tenantId, payment.locationId);
    // Abono directo de una caja abierta: deja de contar sin ajuste.
    if ((await statusOf(payment.cashSessionId)) === 'OPEN') return;
    originalSessionId = payment.cashSessionId;
    targetSessionId = await actorSession();
  } else {
    await lockCashAdjustmentAssignment(tx, input.tenantId, payment.locationId);
    const late = await tx.cashSessionAdjustment.findFirst({
      where: { paymentId: payment.id, kind: 'LATE_PAYMENT' },
      select: { sessionId: true },
    });
    if (!late) return; // Nunca entró en un arqueo: como hasta ahora.
    if (late.sessionId === null) {
      targetSessionId = null; // Pendiente: se compensa también pendiente.
    } else if ((await statusOf(late.sessionId)) === 'OPEN') {
      targetSessionId = late.sessionId;
    } else {
      originalSessionId = late.sessionId;
      targetSessionId = await actorSession();
    }
  }

  await tx.cashSessionAdjustment.create({
    data: {
      tenantId: input.tenantId,
      locationId: payment.locationId,
      sessionId: targetSessionId,
      kind: 'VOID',
      paymentId: payment.id,
      originalSessionId,
      currency: payment.currency,
      method: methodBucket(payment.method),
      amount: new Prisma.Decimal(
        collectedAmount(
          payment.amount.toNumber(),
          payment.methodAdjustments.map((a) => ({
            type: a.type,
            amount: a.amount.toNumber(),
          })),
        ),
      ).negated(),
      createdById: input.voidedById,
    },
  });
}
