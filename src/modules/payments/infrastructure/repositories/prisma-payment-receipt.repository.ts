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
import {
  FROZEN_RATE_SELECT,
  frozenRateOf,
} from './frozen-exchange-rate.mapper';
import {
  loadNoticeSettings,
  loadNoticeResponsibles,
} from '../../../patients/infrastructure/notices/notice-context';

const RECEIPT_PATIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  documentType: true,
  docTypeLabel: true,
  docNumber: true,
  email: true,
  birthDate: true,
  emergencyContactName: true,
} satisfies Prisma.PatientSelect;

const RECEIPT_SOURCE_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  treatmentPlanId: true,
  amount: true,
  currency: true,
  method: true,
  reference: true,
  paymentMethod: { select: { name: true } },
  paidAt: true,
  createdAt: true,
  createdById: true,
  deletedAt: true,
  voidedAt: true,
  voidReason: true,
  // DX-376: la tasa congelada del abono (DX-375), para el equivalente.
  ...FROZEN_RATE_SELECT,
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
      patient: { select: RECEIPT_PATIENT_SELECT },
    },
  },
  // DX-262: abono contra un saldo migrado (sin plan).
  openingBalance: {
    select: {
      id: true,
      concept: true,
      asOfDate: true,
      patient: { select: RECEIPT_PATIENT_SELECT },
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
      // DX-390: una línea de un cobro dividido tiene el recibo de su línea 1.
      const line = await tx.payment.findFirst({
        where: { id: paymentId },
        select: { splitId: true },
      });
      if (!line) return null;
      const payment = await tx.payment.findFirst({
        where: { id: line.splitId ?? paymentId },
        select: RECEIPT_SOURCE_SELECT,
      });
      if (!payment) return null;
      const patient = payment.plan?.patient ?? payment.openingBalance?.patient;
      if (!patient) {
        // payments_target_check: todo abono tiene plan o saldo migrado.
        throw new Error(`Abono ${payment.id} sin plan ni saldo migrado`);
      }
      const patientEmail = patient.email?.trim() ? patient.email.trim() : null;
      const [responsibles, settings] = await Promise.all([
        loadNoticeResponsibles(tx, patient.id),
        loadNoticeSettings(tx, payment.tenantId, payment.locationId),
      ]);
      const base = {
        paymentId: payment.id,
        treatmentPlanId: payment.treatmentPlanId,
        patientEmail,
        notice: {
          patient: {
            firstName: patient.firstName,
            birthDate: patient.birthDate,
            email: patientEmail,
            emergencyContactName: patient.emergencyContactName,
          },
          responsibles,
          settings,
        },
        rate: {
          amount: payment.amount.toNumber(),
          currency: payment.currency,
          exchangeRateCurrency: payment.exchangeRateCurrency,
          frozenRate: frozenRateOf(payment),
        },
        splitRates: line.splitId
          ? (
              await tx.payment.findMany({
                where: { tenantId: payment.tenantId, splitId: line.splitId },
                select: {
                  id: true,
                  amount: true,
                  currency: true,
                  ...FROZEN_RATE_SELECT,
                },
                orderBy: { splitLine: 'asc' },
              })
            ).map((row) => ({
              paymentId: row.id,
              amount: row.amount.toNumber(),
              currency: row.currency,
              exchangeRateCurrency: row.exchangeRateCurrency,
              frozenRate: frozenRateOf(row),
            }))
          : [],
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
              docType: patient.documentType,
              docTypeLabel: patient.docTypeLabel,
              docNumber: patient.docNumber,
            },
            payment: {
              id: payment.id,
              amount: payment.amount.toNumber(),
              currency: payment.currency,
              method: payment.method,
              paymentMethodName: payment.paymentMethod?.name ?? null,
              reference: payment.reference,
              paidAt: payment.paidAt,
              paidOn: civilDateIn(payment.paidAt, zoneOf(payment.locationId)),
            },
            plan: payment.plan
              ? {
                  id: payment.plan.id,
                  optionLabel: payment.plan.optionLabel,
                  createdAt: payment.plan.createdAt,
                }
              : null,
            openingBalance: payment.openingBalance
              ? {
                  id: payment.openingBalance.id,
                  concept: payment.openingBalance.concept,
                  asOfDate: payment.openingBalance.asOfDate
                    .toISOString()
                    .slice(0, 10),
                }
              : null,
            cashier,
          },
        },
      };
    });
  }
}
