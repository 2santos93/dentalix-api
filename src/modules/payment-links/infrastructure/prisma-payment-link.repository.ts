import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentReportStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { withClinicLogoUrl } from '../../../shared/storage/clinic-logo-url';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { PaymentProofAttachment } from '../../payments/domain/payment-proof';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  PAYMENT_REPORT_REJECTED_REASON,
  PAYMENT_REPORT_SUBMITTED_REASON,
  type PaymentLinkChannel,
  type PaymentLinkConcept,
} from '../domain/payment-link';
import type {
  ClinicBrandingRow,
  IssuePaymentLinkInput,
  IssuedPaymentLink,
  LinkInstructionRow,
  LinkMethodRow,
  PatientPaymentLinkRow,
  PaymentLinkBalanceTarget,
  PaymentLinkLocation,
  PaymentLinkPatient,
  PaymentLinkPlanTarget,
  PaymentLinkRepository,
  PaymentReportRow,
  PublicPaymentLinkRow,
  RejectReportOutcome,
  ReportListQuery,
  SubmitReportInput,
  SubmitReportOutcome,
} from '../domain/ports/payment-link-repository.port';

type Tx = Prisma.TransactionClient;

const REPORT_INCLUDE = {
  paymentMethod: { select: { name: true } },
  link: {
    select: {
      id: true,
      treatmentPlanId: true,
      openingBalanceId: true,
      amount: true,
      currency: true,
      concept: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PaymentReportInclude;

type ReportRow = Prisma.PaymentReportGetPayload<{
  include: typeof REPORT_INCLUDE;
}>;

function civilDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function proofOf(row: {
  proofUploadId: string | null;
  proofKey: string | null;
  proofMime: string | null;
  proofSize: number | null;
  proofSha256: string | null;
  proofName: string | null;
}): PaymentProofAttachment | null {
  if (
    row.proofUploadId === null ||
    row.proofKey === null ||
    row.proofMime === null ||
    row.proofSize === null ||
    row.proofSha256 === null ||
    row.proofName === null
  ) {
    return null;
  }
  return {
    uploadId: row.proofUploadId,
    key: row.proofKey,
    mime: row.proofMime as PaymentProofAttachment['mime'],
    size: row.proofSize,
    sha256: row.proofSha256,
    name: row.proofName,
  };
}

function toReport(row: ReportRow, patientName: string): PaymentReportRow {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    patientId: row.patientId,
    patientName,
    locationId: row.locationId,
    paymentMethodId: row.paymentMethodId,
    paymentMethodName: row.paymentMethod.name,
    amount: row.amount.toNumber(),
    currency: row.currency,
    reference: row.reference,
    paidOn: civilDay(row.paidOn),
    note: row.note,
    proof: proofOf(row),
    paymentId: row.paymentId,
    rejectReason: row.rejectReason,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt,
    link: {
      id: row.link.id,
      treatmentPlanId: row.link.treatmentPlanId,
      openingBalanceId: row.link.openingBalanceId,
      amount: row.link.amount.toNumber(),
      currency: row.link.currency,
      concept: row.link.concept as PaymentLinkConcept,
      createdAt: row.link.createdAt,
    },
  };
}

/**
 * Enlaces de pago y reportes del paciente (DX-569) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): un enlace, un reporte o un destino de otra
 * clínica no existe. `tenants` no tiene RLS: se acota por el tenant del
 * contexto.
 */
@Injectable()
export class PrismaPaymentLinkRepository implements PaymentLinkRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  // --- crear el enlace ------------------------------------------------------

  findPatient(patientId: string): Promise<PaymentLinkPatient | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          email: true,
          phone: true,
          contactChannel: true,
          reminderOptOutAt: true,
        },
      }),
    );
  }

  findPlanTarget(
    patientId: string,
    planId: string,
  ): Promise<PaymentLinkPlanTarget | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const plan = await tx.treatmentPlan.findFirst({
        where: { id: planId, patientId, deletedAt: null },
        select: {
          id: true,
          status: true,
          currency: true,
          acceptedLocationId: true,
          presentedLocationId: true,
        },
      });
      if (!plan) return null;
      const active = await tx.paymentPlan.findFirst({
        where: {
          treatmentPlanId: planId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      return {
        id: plan.id,
        status: plan.status,
        currency: plan.currency,
        locationId: plan.acceptedLocationId ?? plan.presentedLocationId,
        hasActivePaymentPlan: active !== null,
      };
    });
  }

  findBalanceTarget(
    patientId: string,
    balanceId: string,
  ): Promise<PaymentLinkBalanceTarget | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.openingBalance.findFirst({
        where: { id: balanceId, patientId, voidedAt: null },
        select: { id: true, currency: true, locationId: true },
      }),
    );
  }

  async clinicName(): Promise<string> {
    // `tenants` no tiene RLS: se lee por el id del contexto.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId() },
      select: { name: true },
    });
    return tenant?.name ?? '';
  }

  linkLocation(locationId: string | null): Promise<PaymentLinkLocation> {
    return this.prisma.runWithTenant(async (tx) => {
      const id = locationId ?? (await this.tenantContext.writeLocationId(tx));
      const location = await tx.location.findFirstOrThrow({
        where: { id },
        select: {
          id: true,
          timeZone: true,
          locale: true,
          hourCycle: true,
          defaultPhoneRegion: true,
        },
      });
      return location;
    });
  }

  async issueLink(input: IssuePaymentLinkInput): Promise<IssuedPaymentLink> {
    const tenantId = this.tenantId();
    const targetId = input.treatmentPlanId ?? input.openingBalanceId;
    if (!targetId) throw new Error('payment_links: destino vacío');
    return this.prisma.runWithTenant(async (tx) => {
      // DX-476: primero el paciente vivo (el orden de archivar), 409 si ya
      // está archivado: nunca un enlace vivo ni un mensaje a un archivado.
      await lockLivePatientOrConflict(tx, input.patientId);
      // Serializa dos creaciones del mismo destino (dos «Enviar enlace» a la
      // vez): sin él, las dos anulan el mismo anterior y el segundo INSERT
      // choca con el único parcial del enlace vivo (500). Candado por destino
      // y transacción: no bloquea filas que lean los abonos.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`payment-link:${tenantId}:${targetId}`}, 0))`;
      // El anterior (vivo o caducado sin usar) deja de servir en la MISMA
      // transacción: un enlace vivo por paciente y destino.
      const revoked = await tx.paymentLink.updateMany({
        where: {
          patientId: input.patientId,
          ...(input.treatmentPlanId
            ? { treatmentPlanId: input.treatmentPlanId }
            : { openingBalanceId: input.openingBalanceId }),
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: input.now },
      });
      const locationId = input.locationId;
      await tx.paymentLink.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          treatmentPlanId: input.treatmentPlanId,
          openingBalanceId: input.openingBalanceId,
          locationId,
          amount: input.amount,
          currency: input.currency,
          concept: input.concept,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          channel: input.channel,
          createdById: input.createdById,
          createdAt: input.now,
        },
        select: { id: true },
      });
      // DX-463: el email del enlace nuevo, en esta misma transacción: si no
      // se puede encolar, se deshace también la anulación del anterior.
      await input.enqueue?.(tx);
      return { id: input.id, revoked: revoked.count };
    });
  }

  listForPatient(patientId: string): Promise<PatientPaymentLinkRow[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) return null;
      const rows = await tx.paymentLink.findMany({
        where: { patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        include: { report: { select: { id: true, status: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        treatmentPlanId: row.treatmentPlanId,
        openingBalanceId: row.openingBalanceId,
        locationId: row.locationId,
        amount: row.amount.toNumber(),
        currency: row.currency,
        concept: row.concept as PaymentLinkConcept,
        channel: row.channel as PaymentLinkChannel | null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        createdById: row.createdById,
        openedAt: row.openedAt,
        usedAt: row.usedAt,
        revokedAt: row.revokedAt,
        report: row.report,
      }));
    });
  }

  // --- rutas públicas -------------------------------------------------------

  findByTokenHash(tokenHash: string): Promise<PublicPaymentLinkRow | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.paymentLink.findFirst({ where: { tokenHash } });
      if (!row) return null;
      // DX-461: el enlace de un paciente archivado no existe para la ruta
      // pública (mismo 404 que caducado o anulado).
      const [patient, location] = await Promise.all([
        tx.patient.findFirst({
          where: { id: row.patientId, deletedAt: null },
          select: { firstName: true },
        }),
        tx.location.findFirst({
          where: { id: row.locationId },
          select: { timeZone: true },
        }),
      ]);
      if (!patient) return null;
      return {
        id: row.id,
        patientId: row.patientId,
        patientFirstName: patient.firstName,
        treatmentPlanId: row.treatmentPlanId,
        openingBalanceId: row.openingBalanceId,
        locationId: row.locationId,
        locationTimeZone: location?.timeZone ?? null,
        amount: row.amount.toNumber(),
        currency: row.currency,
        concept: row.concept as PaymentLinkConcept,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        openedAt: row.openedAt,
        usedAt: row.usedAt,
        revokedAt: row.revokedAt,
        proofUploadsIssued: row.proofUploadsIssued,
        stagedProof: proofOf({
          proofUploadId: row.stagedProofUploadId,
          proofKey: row.stagedProofKey,
          proofMime: row.stagedProofMime,
          proofSize: row.stagedProofSize,
          proofSha256: row.stagedProofSha256,
          proofName: row.stagedProofName,
        }),
      };
    });
  }

  async clinicBranding(): Promise<ClinicBrandingRow | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    const row = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId(), deletedAt: null },
      select: { name: true, primaryColor: true, logoKey: true },
    });
    return withClinicLogoUrl(row);
  }

  linkMethods(): Promise<{
    methods: LinkMethodRow[];
    instructions: LinkInstructionRow[];
  }> {
    return this.prisma.runWithTenant(async (tx) => {
      const methods = await tx.clinicPaymentMethod.findMany({
        where: { active: true, allowInPaymentLink: true },
        select: {
          id: true,
          name: true,
          active: true,
          allowInPaymentLink: true,
          requiresReference: true,
          proofPolicy: true,
        },
        orderBy: { name: 'asc' },
      });
      const instructions =
        methods.length === 0
          ? []
          : await tx.paymentMethodInstruction.findMany({
              where: { paymentMethodId: { in: methods.map((m) => m.id) } },
              select: {
                paymentMethodId: true,
                locationId: true,
                holderName: true,
                holderId: true,
                bankName: true,
                accountNumber: true,
                phone: true,
                email: true,
                note: true,
              },
            });
      return { methods, instructions };
    });
  }

  /**
   * Las monedas que cobra la clínica: las de sus sedes vivas, las que tienen
   * texto propio (DX-517, p. ej. «Bs.») y las que tienen alguna tasa manual
   * registrada (DX-374). Tablas pequeñas; nunca se recorren los abonos.
   */
  async clinicCurrencies(): Promise<string[]> {
    // `tenants` no tiene RLS: se lee por el id del contexto.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId() },
      select: { currencyTexts: true },
    });
    const texts = tenant?.currencyTexts;
    const textCodes =
      texts && typeof texts === 'object' && !Array.isArray(texts)
        ? Object.keys(texts).filter((c) => /^[A-Z]{3}$/.test(c))
        : [];
    const [locations, manual] = await this.prisma.runWithTenant((tx) =>
      Promise.all([
        tx.location.findMany({
          where: { deletedAt: null, currency: { not: null } },
          select: { currency: true },
          distinct: ['currency'],
        }),
        tx.manualExchangeRate.findMany({
          select: { currency: true },
          distinct: ['currency'],
        }),
      ]),
    );
    return [
      ...new Set([
        ...locations.flatMap((r) => (r.currency ? [r.currency] : [])),
        ...manual.map((r) => r.currency),
        ...textCodes,
      ]),
    ].sort();
  }

  async markOpened(linkId: string, now: Date): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.paymentLink.updateMany({
        where: { id: linkId, openedAt: null },
        data: { openedAt: now },
      }),
    );
  }

  reserveProofUpload(linkId: string, now: Date): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: dos peticiones a la vez no pasan del tope (el UPDATE
      // relee la fila tras esperar a la otra).
      const { count } = await tx.paymentLink.updateMany({
        where: {
          id: linkId,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
          proofUploadsIssued: { lt: 3 },
        },
        data: { proofUploadsIssued: { increment: 1 } },
      });
      return count === 1;
    });
  }

  async releaseProofUpload(linkId: string): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.paymentLink.updateMany({
        where: { id: linkId, proofUploadsIssued: { gt: 0 } },
        data: { proofUploadsIssued: { decrement: 1 } },
      }),
    );
  }

  stageProof(
    linkId: string,
    proof: PaymentProofAttachment,
    now: Date,
  ): Promise<{ replacedKey: string | null } | undefined> {
    return this.prisma.runWithTenant(async (tx) => {
      const [current] = await tx.$queryRaw<{ stagedProofKey: string | null }[]>`
        SELECT "stagedProofKey" FROM "payment_links"
         WHERE "id" = ${linkId}::uuid
           AND "usedAt" IS NULL AND "revokedAt" IS NULL
           AND "expiresAt" > ${now}
         FOR NO KEY UPDATE`;
      if (!current) return undefined;
      await tx.paymentLink.update({
        where: { id: linkId },
        data: {
          stagedProofUploadId: proof.uploadId,
          stagedProofKey: proof.key,
          stagedProofMime: proof.mime,
          stagedProofSize: proof.size,
          stagedProofSha256: proof.sha256,
          stagedProofName: proof.name,
        },
      });
      return { replacedKey: current.stagedProofKey };
    });
  }

  submitReport(input: SubmitReportInput): Promise<SubmitReportOutcome> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx): Promise<SubmitReportOutcome> => {
        // Uso único (D5): el UPDATE condicional decide entre dos reportes a la
        // vez; el segundo espera al COMMIT del primero, relee la fila y no la
        // cuenta. Paciente vivo (DX-461) y enlace sin anular ni caducar.
        const { count } = await tx.paymentLink.updateMany({
          where: {
            id: input.linkId,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now },
          },
          data: { usedAt: input.now },
        });
        const link = await tx.paymentLink.findFirst({
          where: { id: input.linkId },
          select: {
            patientId: true,
            locationId: true,
            usedAt: true,
          },
        });
        if (!link) return { kind: 'GONE' };
        if (count === 0)
          return link.usedAt ? { kind: 'USED' } : { kind: 'GONE' };
        const patient = await tx.patient.findFirst({
          where: { id: link.patientId, deletedAt: null },
          select: { id: true },
        });
        // Archivado entre la lectura y el UPDATE: se deshace (404 genérico).
        if (!patient) throw new LinkGoneError();
        const proof = input.proof;
        await tx.paymentReport.create({
          data: {
            id: input.id,
            tenantId,
            linkId: input.linkId,
            patientId: link.patientId,
            locationId: link.locationId,
            paymentMethodId: input.paymentMethodId,
            amount: input.amount,
            currency: input.currency,
            reference: input.reference,
            paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
            note: input.note,
            proofUploadId: proof?.uploadId ?? null,
            proofKey: proof?.key ?? null,
            proofMime: proof?.mime ?? null,
            proofSize: proof?.size ?? null,
            proofSha256: proof?.sha256 ?? null,
            proofName: proof?.name ?? null,
            createdAt: input.now,
          },
          select: { id: true },
        });
        // Actor público (sin sesión ni usuario), origen PUBLIC_LINK: solo ids y
        // el motivo (ni importes ni la referencia). CHECK de actor DX-569.
        await writeAuditEvent(tx, {
          tenantId,
          locationId: link.locationId,
          actor: { kind: 'public' },
          action: 'CREATE',
          resourceType: 'PAYMENT_REPORT',
          resourceId: input.id,
          patient: { kind: 'patient', id: link.patientId },
          requestId: input.meta.requestId,
          ip: input.meta.ip,
          userAgent: input.meta.userAgent,
          metadata: {
            origin: 'PUBLIC_LINK',
            reason: PAYMENT_REPORT_SUBMITTED_REASON,
            params: { linkId: input.linkId },
          },
        });
        return { kind: 'CREATED', reportId: input.id };
      })
      .catch((error: unknown) => {
        if (error instanceof LinkGoneError) {
          return { kind: 'GONE' } satisfies SubmitReportOutcome;
        }
        throw error;
      });
  }

  // --- bandeja --------------------------------------------------------------

  private async withPatientNames(
    tx: Tx,
    rows: ReportRow[],
  ): Promise<PaymentReportRow[]> {
    const ids = [...new Set(rows.map((r) => r.patientId))];
    const patients =
      ids.length === 0
        ? []
        : await tx.patient.findMany({
            where: { id: { in: ids } },
            select: { id: true, firstName: true, lastName: true },
          });
    const names = new Map(
      patients.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]),
    );
    return rows.map((r) => toReport(r, names.get(r.patientId) ?? ''));
  }

  private scopeWhere(
    status: PaymentReportStatus | null,
    locationIds: string[] | undefined,
  ): Prisma.PaymentReportWhereInput {
    return {
      ...(status ? { status } : {}),
      ...(locationIds === undefined
        ? {}
        : locationIds.length === 1
          ? { locationId: locationIds[0] }
          : { locationId: { in: locationIds } }),
    };
  }

  listReports(
    query: ReportListQuery,
  ): Promise<{ items: PaymentReportRow[]; total: number }> {
    return this.prisma.runWithTenant(async (tx) => {
      const where = this.scopeWhere(query.status, query.locationIds);
      const [rows, total] = await Promise.all([
        tx.paymentReport.findMany({
          where,
          include: REPORT_INCLUDE,
          // Lo pendiente, del más antiguo al más reciente (se atiende en
          // orden); lo decidido, lo último primero.
          orderBy:
            query.status === 'PENDING'
              ? [{ createdAt: 'asc' }, { id: 'asc' }]
              : [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        tx.paymentReport.count({ where }),
      ]);
      return { items: await this.withPatientNames(tx, rows), total };
    });
  }

  countReports(
    status: PaymentReportStatus,
    locationIds: string[] | undefined,
  ): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.paymentReport.count({ where: this.scopeWhere(status, locationIds) }),
    );
  }

  findReport(id: string): Promise<PaymentReportRow | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.paymentReport.findFirst({
        where: { id },
        include: REPORT_INCLUDE,
      });
      if (!row) return null;
      const [report] = await this.withPatientNames(tx, [row]);
      return report;
    });
  }

  async confirmInTx(
    tx: Tx,
    input: {
      reportId: string;
      paymentId: string;
      decidedById: string;
      now: Date;
    },
  ): Promise<boolean> {
    const { count } = await tx.paymentReport.updateMany({
      where: { id: input.reportId, status: 'PENDING' },
      data: {
        status: 'CONFIRMED',
        paymentId: input.paymentId,
        decidedById: input.decidedById,
        decidedAt: input.now,
      },
    });
    return count === 1;
  }

  rejectReport(input: {
    reportId: string;
    reason: string;
    now: Date;
    audit: AuditRequestContext;
  }): Promise<RejectReportOutcome> {
    const { audit } = input;
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.paymentReport.updateMany({
        where: { id: input.reportId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectReason: input.reason,
          decidedById: audit.actor.userId,
          decidedAt: input.now,
        },
      });
      const row = await tx.paymentReport.findFirst({
        where: { id: input.reportId },
        include: REPORT_INCLUDE,
      });
      if (!row) return { kind: 'NOT_FOUND' };
      if (count === 0) return { kind: 'NOT_PENDING' };
      // El motivo es texto libre interno: solo su código va en el evento.
      await writeAuditEvent(tx, {
        tenantId: audit.tenantId,
        locationId: row.locationId,
        actor: {
          kind: 'user',
          userId: audit.actor.userId,
          role: audit.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'PAYMENT_REPORT',
        resourceId: row.id,
        patient: { kind: 'patient', id: row.patientId },
        requestId: audit.requestId,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          reason: PAYMENT_REPORT_REJECTED_REASON,
          statusChange: { from: 'PENDING', to: 'REJECTED' },
        },
      });
      const [report] = await this.withPatientNames(tx, [row]);
      return { kind: 'REJECTED', report };
    });
  }

  patientContact(
    patientId: string,
  ): Promise<{ firstName: string; email: string | null } | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { firstName: true, email: true },
      }),
    );
  }
}

/** El paciente se archivó entre la lectura del enlace y su uso. */
class LinkGoneError extends Error {}
