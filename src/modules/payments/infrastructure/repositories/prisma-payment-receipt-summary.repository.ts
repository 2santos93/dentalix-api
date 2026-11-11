import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { loadPeriodLocationZones } from '../../../../shared/locations/location-time-zone';
import {
  civilDateIn,
  civilPeriodByZone,
} from '../../../../shared/time/civil-day';
import type {
  PaymentReceiptSummaryRepository,
  ReceiptSummaryQuery,
  ReceiptSummaryRecipientSource,
  ReceiptSummarySource,
} from '../../domain/ports/payment-receipt-summary-repository.port';
import type { ReceiptSummarySourceItem } from '../../domain/receipt-summary';
import { parseReceiptSnapshot } from '../../domain/receipt-snapshot';
import {
  formatReceiptNumber,
  legacyReceiptReference,
} from '../../domain/receipt-number';
import {
  loadNoticeResponsibles,
  loadMajorityReview,
  loadNoticeSettings,
} from '../../../patients/infrastructure/notices/notice-context';

const SUMMARY_PAYMENT_SELECT = {
  id: true,
  locationId: true,
  amount: true,
  currency: true,
  method: true,
  paymentMethod: { select: { name: true } },
  createdAt: true,
  deletedAt: true,
  voidedAt: true,
  voidReason: true,
  location: { select: { name: true } },
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
} satisfies Prisma.PaymentSelect;

type SummaryPaymentRow = Prisma.PaymentGetPayload<{
  select: typeof SUMMARY_PAYMENT_SELECT;
}>;

/** Un recibo emitido sale de su FOTO; uno «sin serie» (anterior a la numeración), del abono de hoy. */
function summaryItem(
  row: SummaryPaymentRow,
  zoneOf: (locationId: string) => string,
): ReceiptSummarySourceItem {
  const zone = zoneOf(row.locationId);
  if (row.receipt) {
    const snapshot = parseReceiptSnapshot(row.receipt.snapshot);
    const parts = snapshot.split
      ? snapshot.split.lines.map((line) => ({
          amount: line.amount,
          currency: line.currency,
          method: line.method,
          paymentMethodName: line.paymentMethodName,
        }))
      : [
          {
            amount: snapshot.payment.amount,
            currency: snapshot.payment.currency,
            method: snapshot.payment.method,
            paymentMethodName: snapshot.payment.paymentMethodName ?? null,
          },
        ];
    return {
      paymentId: row.id,
      locationId: row.locationId,
      receiptNumber: formatReceiptNumber(
        row.receipt.seriesPrefix,
        row.receipt.number,
      ),
      issuedAt: row.receipt.issuedAt,
      issuedOn: civilDateIn(row.receipt.issuedAt, zone),
      locationName: snapshot.location.name,
      voided: row.receipt.voidedAt !== null,
      voidReason: row.receipt.voidReason,
      parts,
    };
  }
  // Como el recibo «sin serie»: los anulados antes de SEC-013 solo tienen deletedAt.
  const voided = (row.voidedAt ?? row.deletedAt) !== null;
  return {
    paymentId: row.id,
    locationId: row.locationId,
    receiptNumber: legacyReceiptReference(row.id),
    issuedAt: row.createdAt,
    issuedOn: civilDateIn(row.createdAt, zone),
    locationName: row.location.name,
    voided,
    voidReason: voided ? (row.voidReason ?? 'Sin motivo registrado') : null,
    parts: [
      {
        amount: row.amount.toNumber(),
        currency: row.currency,
        method: row.method,
        paymentMethodName: row.paymentMethod?.name ?? null,
      },
    ],
  };
}

/**
 * DX-401: los recibos de un paciente en un período, bajo la RLS de la
 * clínica del contexto, en UNA consulta sobre `payments` (índice
 * `(tenantId, patientId)`) con su recibo: por cada zona horaria de las sedes,
 * los recibos emitidos en ese tramo de instantes y, para los abonos
 * anteriores a la numeración (sin recibo), su alta. Las líneas 2..n de un
 * cobro dividido no tienen recibo propio: van en la foto del de su línea 1.
 */
@Injectable()
export class PrismaPaymentReceiptSummaryRepository implements PaymentReceiptSummaryRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(query: ReceiptSummaryQuery): Promise<ReceiptSummarySource | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: query.patientId, deletedAt: null },
        select: {
          id: true,
          tenantId: true,
          firstName: true,
          lastName: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
          patientCode: true,
        },
      });
      if (!patient) return null;
      const { tenantId } = patient;
      const [tenant, zones] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            legalName: true,
            taxId: true,
            taxIdLabel: true,
            fiscalAddress: true,
          },
        }),
        // Una sede sin zona válida solo da 409 si el paciente tiene abonos en ella.
        loadPeriodLocationZones(
          tx,
          tenantId,
          query.locationIds,
          async (ids) => {
            const row = await tx.payment.findFirst({
              where: {
                tenantId,
                patientId: patient.id,
                locationId: { in: ids },
              },
              select: { locationId: true },
            });
            return row?.locationId ?? null;
          },
        ),
      ]);
      const branches = civilPeriodByZone(
        query.from,
        query.to,
        zones.configured,
      );
      const rows =
        branches.length === 0
          ? []
          : await tx.payment.findMany({
              where: {
                tenantId,
                patientId: patient.id,
                OR: branches.map((branch) => ({
                  locationId: { in: branch.locationIds },
                  OR: [
                    {
                      receipt: {
                        is: {
                          issuedAt: { gte: branch.start, lt: branch.end },
                        },
                      },
                    },
                    {
                      receipt: { is: null },
                      splitId: null,
                      createdAt: { gte: branch.start, lt: branch.end },
                    },
                  ],
                })),
              },
              select: SUMMARY_PAYMENT_SELECT,
            });
      const { id, firstName, lastName, documentType, docTypeLabel } = patient;
      return {
        patient: {
          id,
          firstName,
          lastName,
          documentType,
          docTypeLabel,
          docNumber: patient.docNumber,
          patientCode: patient.patientCode,
        },
        clinic: {
          name: tenant.name,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          taxIdLabel: tenant.taxIdLabel,
          address: tenant.fiscalAddress,
        },
        items: rows.map((row) => summaryItem(row, (l) => zones.zoneOf(l))),
      };
    });
  }

  recipient(
    patientId: string,
    locationId: string,
  ): Promise<ReceiptSummaryRecipientSource> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirstOrThrow({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          tenantId: true,
          firstName: true,
          birthDate: true,
          email: true,
          emergencyContactName: true,
        },
      });
      const patientEmail = patient.email?.trim() ? patient.email.trim() : null;
      const [responsibles, majorityReview, settings] = await Promise.all([
        loadNoticeResponsibles(tx, patient.id),
        loadMajorityReview(tx, patient.id),
        loadNoticeSettings(tx, patient.tenantId, locationId),
      ]);
      return {
        patientEmail,
        notice: {
          patient: {
            firstName: patient.firstName,
            birthDate: patient.birthDate,
            email: patientEmail,
            emergencyContactName: patient.emergencyContactName,
          },
          responsibles,
          majorityReview,
          settings,
        },
      };
    });
  }
}
