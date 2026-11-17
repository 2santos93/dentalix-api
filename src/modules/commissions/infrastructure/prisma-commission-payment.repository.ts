import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../shared/locations/default-location';
import { civilDateIn } from '../../../shared/time/civil-day';
import { currentRequestId } from '../../../shared/observability/request-context';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { guardFinancialLock } from '../../financial-lock/infrastructure/financial-lock-tx';
import type { CommissionReceiptContent } from '../domain/commission-receipt';
import type {
  CommissionPaymentRepository,
  CommissionTx,
  DocumentLine,
  NewCommissionPayment,
  PaymentRecord,
  ReceiptEvidence,
  ReceiptRequestRecord,
  SettlementDocumentSource,
  SettlementHeader,
} from '../domain/ports/commission-payment-repository.port';
import {
  patientInitials,
  type PayableLine,
} from '../domain/settlement-payments';
import type {
  CommissionPaymentReceiptView,
  CommissionPaymentView,
} from '../domain/views';

const dec = (value: Prisma.Decimal | null): number => value?.toNumber() ?? 0;
const civil = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Un día civil en una zona, o el día UTC si la zona no sirve. */
function dayIn(instant: Date, zone: string | null): string {
  if (zone) {
    try {
      return civilDateIn(instant, zone);
    } catch {
      // Zona inválida: día UTC.
    }
  }
  return civil(instant);
}

type PaymentRow = Prisma.CommissionPaymentGetPayload<{
  include: {
    lines: { select: { lineId: true } };
    receipts: true;
  };
}>;

function receiptViewOf(
  receipts: PaymentRow['receipts'],
  now: Date,
): CommissionPaymentReceiptView {
  const signed = receipts.find((r) => r.signedAt !== null);
  if (signed) {
    return {
      status: 'SIGNED',
      requestedAt: signed.createdAt,
      expiresAt: signed.expiresAt,
      signedAt: signed.signedAt,
      signerName: signed.signerName,
    };
  }
  const latest = [...receipts]
    .filter((r) => r.revokedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) {
    return {
      status: 'NONE',
      requestedAt: null,
      expiresAt: null,
      signedAt: null,
      signerName: null,
    };
  }
  return {
    status: latest.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING',
    requestedAt: latest.createdAt,
    expiresAt: latest.expiresAt,
    signedAt: null,
    signerName: null,
  };
}

function receiptRecordOf(
  row: Prisma.CommissionReceiptRequestGetPayload<{
    include: { payment: { select: { voidedAt: true } } };
  }>,
): ReceiptRequestRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    content: row.content as unknown as CommissionReceiptContent,
    contentHash: row.contentHash,
    expiresAt: row.expiresAt,
    openedAt: row.openedAt,
    signedAt: row.signedAt,
    signerName: row.signerName,
    signature: row.signature,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    receiptHash: row.receiptHash,
    revokedAt: row.revokedAt,
    paymentVoided: row.payment.voidedAt !== null,
  };
}

/** 23505 del único parcial «una línea, un pago vivo». */
function isLiveLineViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * DX-464: pagos de la liquidación, su gasto (por el gancho de Gastos) y la
 * conformidad del profesional. Todo bajo RLS (`runWithTenant`); las
 * escrituras del pago van en la transacción del gasto.
 */
@Injectable()
export class PrismaCommissionPaymentRepository implements CommissionPaymentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  header(settlementId: string): Promise<SettlementHeader | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      this.headerIn(tx, tenantId, settlementId),
    );
  }

  private async headerIn(
    tx: CommissionTx,
    tenantId: string,
    settlementId: string,
  ): Promise<SettlementHeader | null> {
    const row = await tx.commissionSettlement.findFirst({
      where: { tenantId, id: settlementId },
      select: {
        id: true,
        userId: true,
        membershipId: true,
        periodFrom: true,
        periodTo: true,
      },
    });
    if (!row) return null;
    const user = await tx.user.findUnique({
      where: { id: row.userId },
      select: { fullName: true, email: true },
    });
    return {
      id: row.id,
      userId: row.userId,
      membershipId: row.membershipId,
      professionalName: user?.fullName ?? '',
      professionalEmail: user?.email ?? null,
      period: { from: civil(row.periodFrom), to: civil(row.periodTo) },
    };
  }

  payableLines(settlementId: string): Promise<PayableLine[]> {
    return this.prisma.runWithTenant((tx) =>
      this.payableLinesIn(tx, settlementId),
    );
  }

  async payableLinesIn(
    tx: CommissionTx,
    settlementId: string,
  ): Promise<PayableLine[]> {
    const rows = await tx.commissionSettlementLine.findMany({
      where: { tenantId: this.tenantId(), settlementId },
      select: {
        id: true,
        currency: true,
        amount: true,
        paymentLines: {
          where: { voidedAt: null },
          select: { paymentId: true },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      currency: r.currency,
      amount: dec(r.amount),
      paymentId: r.paymentLines[0]?.paymentId ?? null,
    }));
  }

  payments(settlementId: string): Promise<CommissionPaymentView[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      this.paymentsIn(tx, tenantId, settlementId, new Date()),
    );
  }

  private async paymentsIn(
    tx: CommissionTx,
    tenantId: string,
    settlementId: string,
    now: Date,
  ): Promise<CommissionPaymentView[]> {
    const rows = await tx.commissionPayment.findMany({
      where: { tenantId, settlementId },
      include: {
        lines: { select: { lineId: true } },
        receipts: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (rows.length === 0) return [];
    const locationIds = [...new Set(rows.map((r) => r.locationId))];
    const userIds = [
      ...new Set(
        rows.flatMap((r) =>
          r.voidedById ? [r.createdById, r.voidedById] : [r.createdById],
        ),
      ),
    ];
    const [locations, users] = await Promise.all([
      tx.location.findMany({
        where: { tenantId, id: { in: locationIds } },
        select: { id: true, name: true },
      }),
      tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, fullName: true },
      }),
    ]);
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    const userName = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => this.paymentViewOf(r, locationName, userName, now));
  }

  private paymentViewOf(
    r: PaymentRow,
    locationName: Map<string, string>,
    userName: Map<string, string>,
    now: Date,
  ): CommissionPaymentView {
    return {
      id: r.id,
      settlementId: r.settlementId,
      currency: r.currency,
      amount: dec(r.amount),
      method: r.method,
      paidOn: civil(r.paidOn),
      reference: r.reference,
      location: {
        id: r.locationId,
        name: locationName.get(r.locationId) ?? '',
      },
      expenseId: r.expenseId,
      lineIds: r.lines.map((l) => l.lineId).sort(),
      createdAt: r.createdAt,
      createdBy: {
        userId: r.createdById,
        name: userName.get(r.createdById) ?? null,
      },
      voidedAt: r.voidedAt,
      voidedBy: r.voidedById
        ? { userId: r.voidedById, name: userName.get(r.voidedById) ?? null }
        : null,
      voidReason: r.voidReason,
      receipt: receiptViewOf(r.receipts, now),
    };
  }

  async findPayment(paymentId: string): Promise<PaymentRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.commissionPayment.findFirst({
        where: { tenantId, id: paymentId },
        select: {
          id: true,
          settlementId: true,
          expenseId: true,
          locationId: true,
          currency: true,
          amount: true,
          paidOn: true,
          voidedAt: true,
        },
      }),
    );
    if (!row) return null;
    return {
      id: row.id,
      settlementId: row.settlementId,
      expenseId: row.expenseId,
      locationId: row.locationId,
      currency: row.currency,
      amount: dec(row.amount),
      paidOn: civil(row.paidOn),
      voided: row.voidedAt !== null,
    };
  }

  async lockSettlement(tx: CommissionTx, settlementId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission_payment:${this.tenantId()}:${settlementId}`}, 0))`;
  }

  async assertDayOpen(
    tx: CommissionTx,
    day: string,
    locationId: string,
    operation: 'PAYMENT_CREATE' | 'PAYMENT_VOID',
    message: string,
  ): Promise<void> {
    const tenantId = this.tenantId();
    await guardFinancialLock(tx, {
      tenantId,
      operation,
      probes: async () => {
        const location = await tx.location.findFirst({
          where: { tenantId, id: locationId },
          select: { timeZone: true },
        });
        return [{ day, timeZone: location?.timeZone ?? 'UTC' }];
      },
      now: new Date(),
      // Sin excepción del ADMIN: el pago de honorarios no la registra.
      actor: null,
      lockedMessage: message,
    });
  }

  async insertPayment(
    tx: CommissionTx,
    payment: NewCommissionPayment,
    ctx: AuditRequestContext,
  ): Promise<string> {
    const tenantId = this.tenantId();
    const id = randomUUID();
    await tx.commissionPayment.create({
      data: {
        id,
        tenantId,
        settlementId: payment.settlementId,
        userId: payment.userId,
        locationId: payment.locationId,
        currency: payment.currency,
        amount: new Prisma.Decimal(payment.amount.toFixed(2)),
        method: payment.method,
        paidOn: asDate(payment.paidOn),
        reference: payment.reference,
        expenseId: payment.expenseId,
        createdById: payment.createdById,
      },
      select: { id: true },
    });
    try {
      await tx.commissionPaymentLine.createMany({
        data: payment.lineIds.map((lineId) => ({
          id: randomUUID(),
          tenantId,
          paymentId: id,
          lineId,
        })),
      });
    } catch (error) {
      if (isLiveLineViolation(error)) throw alreadyPaidConflict();
      throw error;
    }
    // Sin importes: liquidación, moneda, medio, día y nº de líneas.
    await writeAuditEvent(
      tx,
      auditDraftFromContext(ctx, {
        action: 'CREATE',
        resourceType: 'COMMISSION_SETTLEMENT',
        resourceId: payment.settlementId,
        metadata: {
          reason: 'COMMISSION_PAYMENT_CREATED',
          params: {
            paymentId: id,
            expenseId: payment.expenseId,
            currency: payment.currency,
            method: payment.method,
            paidOn: payment.paidOn,
            lines: String(payment.lineIds.length),
          },
        },
      }),
    );
    await writeAuditEvent(tx, {
      ...auditDraftFromContext(ctx, {
        action: 'CREATE',
        resourceType: 'EXPENSE',
        resourceId: payment.expenseId,
        metadata: {
          reason: 'COMMISSION_PAYMENT',
          params: { settlementId: payment.settlementId, paymentId: id },
        },
      }),
      locationId: payment.locationId,
    });
    return id;
  }

  async voidPayment(
    tx: CommissionTx,
    payment: PaymentRecord,
    reason: string,
    ctx: AuditRequestContext,
  ): Promise<boolean> {
    const tenantId = this.tenantId();
    const { count } = await tx.commissionPayment.updateMany({
      where: { tenantId, id: payment.id, voidedAt: null },
      // La BD pone la hora (trigger); `now` satisface el CHECK de anulación completa.
      data: {
        voidedAt: new Date(),
        voidedById: ctx.actor.userId,
        voidReason: reason,
      },
    });
    if (count === 0) return false;
    await tx.commissionPaymentLine.updateMany({
      where: { tenantId, paymentId: payment.id, voidedAt: null },
      data: { voidedAt: new Date() },
    });
    await tx.commissionReceiptRequest.updateMany({
      where: {
        tenantId,
        paymentId: payment.id,
        signedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedById: ctx.actor.userId },
    });
    // El motivo es texto libre: se queda en el pago, no en la auditoría.
    await writeAuditEvent(
      tx,
      auditDraftFromContext(ctx, {
        action: 'VOID',
        resourceType: 'COMMISSION_SETTLEMENT',
        resourceId: payment.settlementId,
        metadata: {
          reason: 'COMMISSION_PAYMENT_VOIDED',
          params: { paymentId: payment.id, expenseId: payment.expenseId },
        },
      }),
    );
    await writeAuditEvent(tx, {
      ...auditDraftFromContext(ctx, {
        action: 'VOID',
        resourceType: 'EXPENSE',
        resourceId: payment.expenseId,
        metadata: {
          reason: 'COMMISSION_PAYMENT',
          params: { settlementId: payment.settlementId, paymentId: payment.id },
        },
      }),
      locationId: payment.locationId,
    });
    return true;
  }

  async settlementDocument(
    settlementId: string,
  ): Promise<SettlementDocumentSource | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const header = await this.headerIn(tx, tenantId, settlementId);
      if (!header) return null;
      const settlement = await tx.commissionSettlement.findFirstOrThrow({
        where: { tenantId, id: settlementId },
        select: { closedAt: true, basis: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const rows = await tx.$queryRaw<
        {
          id: string;
          kind: 'ACCRUAL' | 'ADJUSTMENT';
          patientName: string | null;
          catalogCode: string;
          catalogLabel: string;
          toothNumber: string;
          locationId: string | null;
          releasedAt: Date | null;
          completedAt: Date | null;
          currency: string;
          base: Prisma.Decimal;
          percent: Prisma.Decimal;
          amount: Prisma.Decimal;
          paymentId: string | null;
        }[]
      >`
        SELECT l."id", l."kind",
               btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
               l."catalogCode", l."catalogLabel", l."toothNumber", l."locationId",
               l."releasedAt", l."completedAt", l."currency", l."base", l."percent", l."amount",
               (SELECT cpl."paymentId" FROM "commission_payment_lines" cpl
                 WHERE cpl."tenantId" = l."tenantId" AND cpl."lineId" = l."id"
                   AND cpl."voidedAt" IS NULL) AS "paymentId"
          FROM "commission_settlement_lines" l
          JOIN "treatment_plan_items" i
            ON i."tenantId" = l."tenantId" AND i."id" = l."treatmentPlanItemId"
          LEFT JOIN "patients" pt ON pt."tenantId" = i."tenantId" AND pt."id" = i."patientId"
         WHERE l."tenantId" = ${tenantId}::uuid AND l."settlementId" = ${settlementId}::uuid
         ORDER BY l."currency", l."kind", l."releasedAt" NULLS LAST, l."catalogCode", l."id"`;
      const defaultLocationId = await resolveDefaultLocationId(tx).catch(
        () => null,
      );
      const locationIds = [
        ...new Set(
          [...rows.map((r) => r.locationId), defaultLocationId].filter(
            (id): id is string => id !== null,
          ),
        ),
      ];
      const locations = await tx.location.findMany({
        where: { tenantId, id: { in: locationIds } },
        select: { id: true, timeZone: true, locale: true, hourCycle: true },
      });
      const byId = new Map(locations.map((l) => [l.id, l]));
      const main = defaultLocationId ? byId.get(defaultLocationId) : undefined;
      const lines: DocumentLine[] = rows.map((r) => {
        const instant = r.releasedAt ?? r.completedAt;
        const zone =
          (r.locationId ? byId.get(r.locationId)?.timeZone : null) ??
          main?.timeZone ??
          null;
        return {
          id: r.id,
          kind: r.kind,
          patientInitials: patientInitials(r.patientName),
          catalogCode: r.catalogCode,
          catalogLabel: r.catalogLabel,
          toothNumber: r.toothNumber,
          day: instant ? dayIn(instant, zone) : null,
          currency: r.currency,
          base: dec(r.base),
          percent: dec(r.percent),
          amount: dec(r.amount),
          paymentId: r.paymentId,
        };
      });
      return {
        clinicName: tenant.name,
        header,
        closedAt: settlement.closedAt,
        basis: settlement.basis,
        lines,
        payments: await this.paymentsIn(tx, tenantId, settlementId, new Date()),
        format: {
          locale: main?.locale ?? null,
          hourCycle: main?.hourCycle ?? null,
          timeZone: main?.timeZone ?? null,
        },
      };
    });
  }

  async createReceiptRequest(
    input: {
      paymentId: string;
      tokenHash: string;
      content: CommissionReceiptContent;
      contentHash: string;
      expiresAt: Date;
    },
    ctx: AuditRequestContext,
  ): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // Mismo candado que pagar y anular: no se pide sobre un pago que se anula a la vez.
      const payment = await tx.commissionPayment.findFirst({
        where: { tenantId, id: input.paymentId },
        select: { settlementId: true },
      });
      if (!payment) throw new Error('Pago no encontrado');
      await this.lockSettlement(tx, payment.settlementId);
      const live = await tx.commissionPayment.findFirst({
        where: { tenantId, id: input.paymentId },
        select: {
          voidedAt: true,
          receipts: {
            where: { signedAt: { not: null } },
            select: { id: true },
          },
        },
      });
      if (!live || live.voidedAt !== null) throw paymentVoidedConflict();
      if (live.receipts.length > 0) throw receiptAlreadySignedConflict();
      await tx.commissionReceiptRequest.updateMany({
        where: {
          tenantId,
          paymentId: input.paymentId,
          signedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedById: ctx.actor.userId },
      });
      const id = randomUUID();
      await tx.commissionReceiptRequest.create({
        data: {
          id,
          tenantId,
          paymentId: input.paymentId,
          tokenHash: input.tokenHash,
          content: input.content as unknown as Prisma.InputJsonValue,
          contentHash: input.contentHash,
          expiresAt: input.expiresAt,
          createdById: ctx.actor.userId,
        },
        select: { id: true },
      });
      // Ni el token ni la URL: solo ids.
      await writeAuditEvent(
        tx,
        auditDraftFromContext(ctx, {
          action: 'SEND',
          resourceType: 'COMMISSION_SETTLEMENT',
          resourceId: payment.settlementId,
          metadata: {
            reason: 'COMMISSION_RECEIPT_REQUESTED',
            params: { paymentId: input.paymentId, receiptRequestId: id },
          },
        }),
      );
    });
  }

  async signedReceipt(paymentId: string): Promise<ReceiptRequestRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.commissionReceiptRequest.findFirst({
        where: { tenantId, paymentId, signedAt: { not: null } },
        include: { payment: { select: { voidedAt: true } } },
      }),
    );
    return row ? receiptRecordOf(row) : null;
  }

  async receiptByToken(
    tokenHash: string,
  ): Promise<ReceiptRequestRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.commissionReceiptRequest.findFirst({
        where: { tenantId, tokenHash },
        include: { payment: { select: { voidedAt: true } } },
      }),
    );
    return row ? receiptRecordOf(row) : null;
  }

  async markReceiptOpened(id: string): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      tx.commissionReceiptRequest.updateMany({
        where: {
          tenantId,
          id,
          openedAt: null,
          signedAt: null,
          revokedAt: null,
        },
        data: { openedAt: new Date() },
      }),
    );
  }

  async signReceipt(
    id: string,
    input: {
      signerName: string;
      signature: string;
      receiptHash: string;
      evidence: ReceiptEvidence;
      now: Date;
    },
  ): Promise<boolean> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.commissionReceiptRequest.updateMany({
        where: {
          tenantId,
          id,
          signedAt: null,
          revokedAt: null,
          expiresAt: { gt: input.now },
          payment: { voidedAt: null },
        },
        // La hora de la firma la pone la BD (trigger).
        data: {
          signedAt: input.now,
          signerName: input.signerName,
          signature: input.signature,
          receiptHash: input.receiptHash,
          ipAddress: input.evidence.ipAddress,
          userAgent: input.evidence.userAgent,
        },
      });
      if (count !== 1) return false;
      // El profesional de la liquidación firma por el enlace (sin sesión):
      // actor = su usuario, sin rol; origen LINK. Sin importes ni nombres.
      const payment = await tx.commissionReceiptRequest.findFirstOrThrow({
        where: { tenantId, id },
        select: {
          paymentId: true,
          payment: { select: { settlementId: true, userId: true } },
        },
      });
      await writeAuditEvent(tx, {
        tenantId,
        locationId: null,
        actor: { kind: 'user', userId: payment.payment.userId, role: null },
        action: 'SIGN',
        resourceType: 'COMMISSION_SETTLEMENT',
        resourceId: payment.payment.settlementId,
        patient: null,
        requestId: currentRequestId() ?? null,
        ip: input.evidence.ipAddress,
        userAgent: input.evidence.userAgent,
        metadata: {
          reason: 'COMMISSION_RECEIPT_SIGNED',
          origin: 'LINK',
          params: { paymentId: payment.paymentId, receiptRequestId: id },
        },
      });
      return true;
    });
  }
}

export function alreadyPaidConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COMMISSION_LINE_ALREADY_PAID',
    message:
      'Alguna de las líneas elegidas ya está pagada. Actualiza la liquidación y vuelve a elegir.',
  });
}

export function paymentVoidedConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COMMISSION_PAYMENT_VOIDED',
    message: 'El pago está anulado.',
  });
}

export function receiptAlreadySignedConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COMMISSION_RECEIPT_ALREADY_SIGNED',
    message: 'El profesional ya firmó la conformidad de este pago.',
  });
}
