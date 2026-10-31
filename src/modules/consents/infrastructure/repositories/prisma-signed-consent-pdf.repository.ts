import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  ArchiveSignedConsentPdfInput,
  RetrySignedConsentPdfOutcome,
  SignedConsentPdfJobSource,
  SignedConsentPdfRepository,
  SignedConsentPdfRetryRepository,
} from '../../domain/ports/signed-consent-pdf-repository.port';

/** Otro intento lo archivó antes: deshace la transacción sin error real. */
class AlreadyReadyRollback extends Error {}

/**
 * Estado y archivo del PDF firmado (DX-422) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): un consentimiento de otra clínica no existe.
 * `tenants` no tiene RLS: se acota por el tenant del contexto.
 */
@Injectable()
export class PrismaSignedConsentPdfRepository
  implements SignedConsentPdfRepository, SignedConsentPdfRetryRepository
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

  loadForJob(consentId: string): Promise<SignedConsentPdfJobSource | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientConsent.findFirst({
        where: { id: consentId, signatureRequestId: { not: null } },
        include: {
          countersignature: {
            select: {
              signedAt: true,
              professionalSignature: true,
              contentHash: true,
            },
          },
          signatureRequest: {
            select: {
              locationId: true,
              professionalUserId: true,
              location: {
                select: {
                  name: true,
                  timeZone: true,
                  locale: true,
                  hourCycle: true,
                },
              },
            },
          },
          signedPdf: { select: { status: true, notifyPatient: true } },
        },
      });
      if (!row?.signatureRequest) return null;
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true },
      });
      const request = row.signatureRequest;
      const counter = row.countersignature;
      const complete =
        counter !== null &&
        row.remoteChannel !== null &&
        row.remoteDestinationMasked !== null &&
        row.remoteSentAt !== null &&
        row.remoteOpenedAt !== null &&
        row.remoteVerifiedAt !== null;
      return {
        consentId: row.id,
        patientId: row.patientId,
        locationId: request.locationId,
        professionalUserId: request.professionalUserId,
        status: row.signedPdf?.status ?? 'PENDING',
        notifyPatient: row.signedPdf?.notifyPatient ?? true,
        source: complete
          ? {
              consentId: row.id,
              clinicName: tenant?.name ?? '',
              title: row.title,
              body: row.body,
              templateVersion: row.templateVersion,
              signerType: row.signerType,
              signerName: row.signerName,
              signerDocument: row.signerDocument,
              professionalName: row.professionalName,
              patientSignature: row.patientSignature,
              professionalSignature: counter.professionalSignature,
              signedAt: row.signedAt,
              professionalSignedAt: counter.signedAt,
              contentHash: row.contentHash,
              countersignatureHash: counter.contentHash,
              channel: row.remoteChannel!,
              destinationMasked: row.remoteDestinationMasked!,
              sentAt: row.remoteSentAt!,
              openedAt: row.remoteOpenedAt!,
              verifiedAt: row.remoteVerifiedAt!,
              ipAddress: row.ipAddress,
              userAgent: row.userAgent,
              location: request.location,
            }
          : null,
      };
    });
  }

  async archive(
    input: ArchiveSignedConsentPdfInput,
    onArchived?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<'ARCHIVED' | 'ALREADY_READY'> {
    const tenantId = this.tenantId();
    try {
      await this.prisma.runWithTenant(async (tx) => {
        await tx.patientDocument.create({
          data: {
            id: input.documentId,
            tenantId,
            patientId: input.patientId,
            locationId: input.locationId,
            category: 'SIGNED_CONSENT',
            originalName: input.originalName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            storageKey: input.storageKey,
            toothNumbers: [],
            uploadedById: input.uploadedById,
          },
        });
        const updated = await tx.signedConsentPdf.updateMany({
          where: {
            consentId: input.consentId,
            patientId: input.patientId,
            status: { not: 'READY' },
          },
          data: {
            status: 'READY',
            documentId: input.documentId,
            attempts: { increment: 1 },
            lastErrorCode: null,
          },
        });
        if (updated.count === 1) {
          await onArchived?.(tx);
          return;
        }
        const exists = await tx.signedConsentPdf.findFirst({
          where: { consentId: input.consentId, patientId: input.patientId },
          select: { id: true },
        });
        if (exists) throw new AlreadyReadyRollback();
        await tx.signedConsentPdf.create({
          data: {
            tenantId,
            patientId: input.patientId,
            consentId: input.consentId,
            status: 'READY',
            documentId: input.documentId,
            attempts: 1,
          },
        });
        await onArchived?.(tx);
      });
      return 'ARCHIVED';
    } catch (error) {
      if (error instanceof AlreadyReadyRollback) return 'ALREADY_READY';
      throw error;
    }
  }

  async recordFailure(
    consentId: string,
    failure: { code: string; final: boolean },
  ): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(async (tx) => {
      const data = {
        status: failure.final ? ('FAILED' as const) : ('PENDING' as const),
        lastErrorCode: failure.code,
        attempts: { increment: 1 },
      };
      const updated = await tx.signedConsentPdf.updateMany({
        where: { consentId, status: { not: 'READY' } },
        data,
      });
      if (updated.count > 0) return;
      const consent = await tx.patientConsent.findFirst({
        where: { id: consentId },
        select: { patientId: true, signedPdf: { select: { id: true } } },
      });
      if (!consent || consent.signedPdf) return;
      await tx.signedConsentPdf.create({
        data: {
          tenantId,
          patientId: consent.patientId,
          consentId,
          status: data.status,
          lastErrorCode: failure.code,
          attempts: 1,
        },
      });
    });
  }

  requestRetry(
    patientId: string,
    consentId: string,
    authorize: (locationId: string | null) => void,
    enqueue: (tx: Prisma.TransactionClient, attempt: number) => Promise<void>,
  ): Promise<RetrySignedConsentPdfOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.signedConsentPdf.findFirst({
        where: { consentId, patientId },
        select: {
          status: true,
          attempts: true,
          consent: {
            select: { signatureRequest: { select: { locationId: true } } },
          },
        },
      });
      if (!row) return 'NOT_FOUND';
      // SEC-060: antes de cambiar el estado, como «Reenviar copia».
      authorize(row.consent.signatureRequest?.locationId ?? null);
      // Condicional: dos «Reintentar» a la vez encolan uno solo.
      const updated = await tx.signedConsentPdf.updateMany({
        where: { consentId, patientId, status: 'FAILED' },
        data: { status: 'PENDING', lastErrorCode: null },
      });
      if (updated.count === 0) return 'NOT_FAILED';
      await enqueue(tx, row.attempts);
      return 'RETRYING';
    });
  }
}
