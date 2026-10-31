import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type {
  ClinicBranding,
  ConsumeSignedPdfCopyOutcome,
  IssueSignedPdfCopyLinkInput,
  SignedConsentPdfBackfillRepository,
  SignedPdfCopyLinkRow,
  SignedPdfCopyRepository,
  SignedPdfCopyTarget,
} from '../../domain/ports/signed-pdf-copy-repository.port';
import { SIGNED_PDF_COPY_DOWNLOADED_REASON } from '../../domain/signed-pdf-copy-link';

/**
 * Copia del PDF firmado (DX-443) en Postgres, todo bajo `runWithTenant` (RLS
 * FORCE): un consentimiento o un enlace de otra clínica no existe. `tenants`
 * no tiene RLS: se acota por el tenant del contexto.
 */
@Injectable()
export class PrismaSignedPdfCopyRepository
  implements SignedPdfCopyRepository, SignedConsentPdfBackfillRepository
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async loadTarget(
    consentId: string,
    patientId?: string,
  ): Promise<SignedPdfCopyTarget | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientConsent.findFirst({
        where: {
          id: consentId,
          ...(patientId ? { patientId } : {}),
          signatureRequestId: { not: null },
          // A un paciente dado de baja (borrado lógico) no se le escribe.
          patient: { deletedAt: null },
        },
        select: {
          id: true,
          patientId: true,
          patient: { select: { firstName: true } },
          signedPdf: { select: { status: true, notifyPatient: true } },
          signatureRequest: {
            select: {
              destination: true,
              destinationMasked: true,
              signerType: true,
              signerName: true,
              location: {
                select: {
                  id: true,
                  timeZone: true,
                  locale: true,
                  hourCycle: true,
                },
              },
            },
          },
        },
      });
      if (!row?.signatureRequest) return null;
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true },
      });
      const request = row.signatureRequest;
      return {
        consentId: row.id,
        patientId: row.patientId,
        ready: row.signedPdf?.status === 'READY',
        notifyPatient: row.signedPdf?.notifyPatient ?? false,
        destination: request.destination,
        destinationMasked: request.destinationMasked,
        signerType: request.signerType,
        signerName: request.signerName,
        patientFirstName: row.patient.firstName,
        clinicName: tenant?.name ?? '',
        location: request.location,
      };
    });
  }

  async issueLink(input: IssueSignedPdfCopyLinkInput): Promise<{ id: string }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Serializa los envíos del mismo consentimiento (dos «Reenviar copia»
      // a la vez, o uno con el envío automático): sin este bloqueo, los dos
      // invalidan el mismo enlace y el segundo INSERT choca con el índice
      // parcial (500). Con él, el segundo espera y ve el enlace del primero.
      await tx.$executeRaw`
        SELECT 1 FROM "signed_consent_pdfs"
        WHERE "consentId" = ${input.consentId}::uuid
          AND "patientId" = ${input.patientId}::uuid
        FOR UPDATE`;
      // El anterior deja de servir en la MISMA transacción (y el índice
      // parcial signed_consent_pdf_links_live_key impide dos vivos).
      await tx.signedConsentPdfLink.updateMany({
        where: {
          consentId: input.consentId,
          patientId: input.patientId,
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: input.now },
      });
      return tx.signedConsentPdfLink.create({
        data: {
          tenantId,
          patientId: input.patientId,
          consentId: input.consentId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
          createdAt: input.now,
        },
        select: { id: true },
      });
    });
  }

  findLinkByTokenHash(tokenHash: string): Promise<SignedPdfCopyLinkRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.signedConsentPdfLink.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          consentId: true,
          patientId: true,
          expiresAt: true,
          usedAt: true,
          revokedAt: true,
        },
      }),
    );
  }

  async consumeLink(
    linkId: string,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<ConsumeSignedPdfCopyOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: dos descargas a la vez, una gana.
      const { count } = await tx.signedConsentPdfLink.updateMany({
        where: {
          id: linkId,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      const link = await tx.signedConsentPdfLink.findFirst({
        where: { id: linkId },
        select: {
          consentId: true,
          patientId: true,
          usedAt: true,
          signedPdf: {
            select: {
              document: {
                select: {
                  storageKey: true,
                  originalName: true,
                  mimeType: true,
                },
              },
              consent: {
                select: { signatureRequest: { select: { locationId: true } } },
              },
            },
          },
        },
      });
      if (!link) return { kind: 'GONE' };
      if (count === 0) {
        return link.usedAt ? { kind: 'USED' } : { kind: 'GONE' };
      }
      const document = link.signedPdf.document;
      // READY ⇔ con documento (CHECK): sin él, el enlace no se habría creado.
      if (!document)
        throw new Error('signed_consent_pdf_links: PDF sin documento');
      await writeAuditEvent(tx, {
        tenantId,
        locationId: link.signedPdf.consent.signatureRequest?.locationId ?? null,
        actor: { kind: 'patient' },
        action: 'EXPORT',
        resourceType: 'CONSENT',
        resourceId: link.consentId,
        patient: { kind: 'patient', id: link.patientId },
        requestId: meta.requestId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: SIGNED_PDF_COPY_DOWNLOADED_REASON,
        },
      });
      return { kind: 'CONSUMED', download: document };
    });
  }

  findClinicBranding(): Promise<ClinicBranding | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    return this.prisma.tenant.findFirst({
      where: { id: this.tenantId(), deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });
  }

  async tenantIds(): Promise<string[]> {
    // `tenants` no tiene RLS: el barrido recorre las clínicas vivas.
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async backfill(
    tenantId: string,
    limit: number,
    enqueue: (tx: Prisma.TransactionClient, consentId: string) => Promise<void>,
  ): Promise<number> {
    const missing = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.patientConsent.findMany({
        where: {
          signatureRequestId: { not: null },
          countersignature: { isNot: null },
          signedPdf: { is: null },
        },
        select: { id: true, patientId: true },
        orderBy: { signedAt: 'asc' },
        take: limit,
      }),
    );
    let queued = 0;
    for (const consent of missing) {
      // Una transacción por consentimiento: el estado y su trabajo juntos.
      // ON CONFLICT DO NOTHING: si la firma o otra réplica ya creó la fila,
      // no se toca ni se encola nada (idempotente).
      const created = await this.prisma.runWithTenant(tenantId, async (tx) => {
        const { count } = await tx.signedConsentPdf.createMany({
          data: [
            {
              tenantId,
              patientId: consent.patientId,
              consentId: consent.id,
              notifyPatient: false,
            },
          ],
          skipDuplicates: true,
        });
        if (count === 1) await enqueue(tx, consent.id);
        return count === 1;
      });
      if (created) queued += 1;
    }
    return queued;
  }
}
