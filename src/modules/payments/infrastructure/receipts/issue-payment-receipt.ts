import { Prisma } from '@prisma/client';
import {
  buildReceiptSnapshot,
  type ReceiptPlanBalance,
  type ReceiptSplitLine,
} from '../../domain/receipt-snapshot';
import { formatReceiptNumber } from '../../domain/receipt-number';
import { effectiveReceiptLegend } from '../../domain/receipt-settings';
import type { PaymentAdjustmentLine } from '../../domain/payment-adjustment-line';
import { readDocumentTypeNames } from '../../../patients/infrastructure/repositories/prisma-document-type-names.repository';

/** El abono recién insertado, en la misma transacción. */
export interface ReceiptPaymentRow {
  id: string;
  tenantId: string;
  locationId: string;
  /** Exactamente uno de los dos (DX-262). */
  treatmentPlanId: string | null;
  openingBalanceId: string | null;
  patientId: string;
  amount: number;
  currency: string;
  method: Prisma.PaymentGetPayload<Record<string, never>>['method'];
  /** DX-377: nombre del medio de pago y referencia, para el recibo. */
  paymentMethodName?: string | null;
  reference?: string | null;
  paidAt: Date;
  paidOn: string;
  createdById: string | null;
  /** DX-516: los ajustes por medio de pago congelados en el abono. */
  adjustments?: PaymentAdjustmentLine[];
  /**
   * DX-390: el cobro dividido cuyo recibo único emite su línea 1: todas sus
   * líneas y la moneda del plan del total.
   */
  split?: { lines: ReceiptSplitLine[]; planCurrency: string };
}

/**
 * Emite el recibo de caja de un abono (DX-136) DENTRO de la transacción que
 * lo inserta:
 *   1. lee clínica (y sus nombres de documento, DX-327), sede (y su serie),
 *      paciente, plan (o saldo migrado, DX-262) y quién cobró;
 *   2. avanza el contador de la serie con un UPSERT: la fila del contador
 *      queda bloqueada hasta el COMMIT, así que dos abonos simultáneos de la
 *      misma sede se ordenan (sin duplicados) y un rollback deshace el
 *      incremento (sin huecos);
 *   3. guarda el recibo con su foto inmutable.
 * Devuelve el número visible (`NOR-000123`). Los triggers de la BD repiten
 * las reglas (número = contador, serie = la de la sede, inmutable).
 */
export async function issuePaymentReceipt(
  tx: Prisma.TransactionClient,
  payment: ReceiptPaymentRow,
  planBalance: ReceiptPlanBalance | null,
): Promise<string> {
  const [location, tenant, names, patient, plan, opening, cashier] =
    await Promise.all([
      tx.location.findFirstOrThrow({
        where: { id: payment.locationId },
        select: {
          id: true,
          name: true,
          address: true,
          receiptPrefix: true,
          // DX-515: la leyenda propia de la sede, si la tiene.
          receiptLegendOverride: true,
          receiptLegend: true,
        },
      }),
      tx.tenant.findUniqueOrThrow({
        where: { id: payment.tenantId },
        // DX-515: título y leyenda del recibo de la clínica.
        select: { name: true, receiptTitle: true, receiptLegend: true },
      }),
      readDocumentTypeNames(tx, payment.tenantId),
      tx.patient.findFirstOrThrow({
        where: { id: payment.patientId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
        },
      }),
      payment.treatmentPlanId
        ? tx.treatmentPlan.findFirstOrThrow({
            where: { id: payment.treatmentPlanId },
            select: { id: true, optionLabel: true, createdAt: true },
          })
        : Promise.resolve(null),
      payment.openingBalanceId
        ? tx.openingBalance.findFirstOrThrow({
            where: { id: payment.openingBalanceId },
            select: { id: true, concept: true, asOfDate: true },
          })
        : Promise.resolve(null),
      payment.createdById
        ? tx.user.findUnique({
            where: { id: payment.createdById },
            select: { id: true, fullName: true },
          })
        : Promise.resolve(null),
    ]);
  if (!location.receiptPrefix) {
    // El trigger de `locations` la pone al crear la sede y la migración la
    // rellenó en las existentes: llegar aquí es un fallo de despliegue.
    throw new Error('La sede del abono no tiene serie de recibos');
  }
  const seriesPrefix = location.receiptPrefix;

  const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
    VALUES (${payment.tenantId}::uuid, ${seriesPrefix}, 1)
    ON CONFLICT ("tenantId", "seriesPrefix")
    DO UPDATE SET "lastNumber" = "payment_receipt_counters"."lastNumber" + 1
    RETURNING "lastNumber"`;

  const snapshot = buildReceiptSnapshot(
    {
      // DX-019 añadirá razón social, identificador fiscal y dirección fiscal de la clínica;
      // hoy no existen y el recibo dice «Datos fiscales pendientes».
      clinic: {
        name: tenant.name,
        legalName: null,
        taxId: null,
        address: null,
      },
      location: {
        id: location.id,
        name: location.name,
        address: location.address,
      },
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
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        paymentMethodName: payment.paymentMethodName ?? null,
        reference: payment.reference ?? null,
        paidAt: payment.paidAt,
        paidOn: payment.paidOn,
        adjustments: payment.adjustments,
      },
      plan,
      openingBalance: opening
        ? {
            id: opening.id,
            concept: opening.concept,
            asOfDate: opening.asOfDate.toISOString().slice(0, 10),
          }
        : null,
      planBalance,
      cashier,
      split: payment.split ?? null,
      // DX-515: se congelan en la foto; sin configurar, la foto es la de antes.
      texts: {
        title: tenant.receiptTitle,
        legend: effectiveReceiptLegend(
          { title: tenant.receiptTitle, legend: tenant.receiptLegend },
          {
            override: location.receiptLegendOverride,
            legend: location.receiptLegend,
          },
        ),
      },
    },
    // El nombre visible queda congelado en la foto (DX-327, R18).
    names,
  );

  await tx.paymentReceipt.create({
    data: {
      tenantId: payment.tenantId,
      locationId: payment.locationId,
      paymentId: payment.id,
      seriesPrefix,
      number: lastNumber,
      issuedById: payment.createdById,
      snapshot: snapshot as unknown as Prisma.InputJsonObject,
    },
  });
  return formatReceiptNumber(seriesPrefix, lastNumber);
}
