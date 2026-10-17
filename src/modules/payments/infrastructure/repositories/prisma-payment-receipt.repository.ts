import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type {
  PaymentReceiptRepository,
  PaymentReceiptSource,
} from '../../domain/ports/payment-receipt-repository.port';
import { parseReceiptSnapshot } from '../../domain/receipt-snapshot';

const RECEIPT_SOURCE_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  treatmentPlanId: true,
  amount: true,
  currency: true,
  method: true,
  paidAt: true,
  createdAt: true,
  createdById: true,
  deletedAt: true,
  voidedAt: true,
  voidReason: true,
  receipt: {
    select: {
      seriesPrefix: true,
      number: true,
      issuedAt: true,
      snapshot: true,
      voidedAt: true,
      voidReason: true,
    },
  },
  location: { select: { id: true, name: true, address: true } },
  plan: {
    select: {
      id: true,
      optionLabel: true,
      createdAt: true,
      patient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          docType: true,
          docNumber: true,
          email: true,
        },
      },
    },
  },
} satisfies Prisma.PaymentSelect;

/**
 * Lectura del recibo de un abono (DX-136), bajo la RLS de la clínica del
 * contexto. Incluye los abonos ANULADOS (su recibo sale marcado) y, para los
 * anteriores a la numeración, lo necesario para mostrarlos «sin serie».
 */
@Injectable()
export class PrismaPaymentReceiptRepository implements PaymentReceiptRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByPaymentId(paymentId: string): Promise<PaymentReceiptSource | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: paymentId },
        select: RECEIPT_SOURCE_SELECT,
      });
      if (!payment) return null;
      const { patient } = payment.plan;
      const base = {
        paymentId: payment.id,
        treatmentPlanId: payment.treatmentPlanId,
        patientEmail: patient.email?.trim() ? patient.email.trim() : null,
      };
      if (payment.receipt) {
        return {
          ...base,
          kind: 'issued',
          receipt: {
            seriesPrefix: payment.receipt.seriesPrefix,
            number: payment.receipt.number,
            issuedAt: payment.receipt.issuedAt,
            snapshot: parseReceiptSnapshot(payment.receipt.snapshot),
            voidedAt: payment.receipt.voidedAt,
            voidReason: payment.receipt.voidReason,
          },
        };
      }

      // Abono anterior a la numeración: sus datos de hoy.
      const [tenant, cashier, zoneOf] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: payment.tenantId },
          select: { name: true },
        }),
        payment.createdById
          ? tx.user.findUnique({
              where: { id: payment.createdById },
              select: { id: true, fullName: true },
            })
          : Promise.resolve(null),
        resolveLocationTimeZones(tx, payment.tenantId, [payment.locationId]),
      ]);
      return {
        ...base,
        kind: 'legacy',
        legacy: {
          issuedAt: payment.createdAt,
          // Los anulados antes de SEC-013 solo tienen deletedAt.
          voidedAt: payment.voidedAt ?? payment.deletedAt,
          voidReason:
            payment.voidedAt || payment.deletedAt
              ? (payment.voidReason ?? 'Sin motivo registrado')
              : null,
          snapshotInput: {
            clinic: {
              name: tenant.name,
              legalName: null,
              taxId: null,
              address: null,
            },
            location: payment.location,
            patient: {
              id: patient.id,
              firstName: patient.firstName,
              lastName: patient.lastName,
              docType: patient.docType,
              docNumber: patient.docNumber,
            },
            payment: {
              id: payment.id,
              amount: payment.amount.toNumber(),
              currency: payment.currency,
              method: payment.method,
              paidAt: payment.paidAt,
              paidOn: civilDateIn(payment.paidAt, zoneOf(payment.locationId)),
            },
            plan: {
              id: payment.plan.id,
              optionLabel: payment.plan.optionLabel,
              createdAt: payment.plan.createdAt,
            },
            cashier,
          },
        },
      };
    });
  }
}
