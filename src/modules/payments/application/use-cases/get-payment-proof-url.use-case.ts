import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../../shared/storage/file-storage.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { PROOF_NOT_FOUND_MESSAGE } from '../../domain/payment-proof';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import { PAYMENT_PROOF_URL_TTL } from '../payment-proof-tokens';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';

export interface PaymentProofUrl {
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  mime: string;
  name: string;
}

@Injectable()
export class GetPaymentProofUrlUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(PAYMENT_CLOCK) private readonly clock: PaymentClock,
    @Inject(PAYMENT_PROOF_URL_TTL) private readonly ttlSeconds: number,
  ) {}

  /**
   * URL firmada de corta vida para ver (`inline`) o descargar (`attachment`)
   * el comprobante. Disposición, nombre y tipo DETECTADO van firmados en la
   * URL. Un abono de otra clínica (RLS) o sin comprobante es 404. Queda
   * auditada aquí y no con `@Audit`: la acción depende de la disposición
   * (VIEW si se abre en el navegador, EXPORT si se descarga). La metadata no
   * lleva datos del paciente (solo el motivo).
   */
  async execute(
    paymentId: string,
    disposition: 'inline' | 'attachment',
    ctx: AuditRequestContext | undefined,
  ): Promise<PaymentProofUrl> {
    const issuedAt = this.clock();
    const proof = await this.repo.findProof(paymentId);
    if (!proof) throw new NotFoundException(PROOF_NOT_FOUND_MESSAGE);
    const { attachment } = proof;
    const url = await this.storage.getSignedUrl(
      attachment.key,
      this.ttlSeconds,
      {
        disposition,
        filename: attachment.name,
        contentType: attachment.mime,
      },
    );
    if (ctx) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: disposition === 'inline' ? 'VIEW' : 'EXPORT',
        resourceType: 'PAYMENT',
        resourceId: proof.paymentId,
        patient: { kind: 'patient', id: proof.patientId },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason:
            disposition === 'inline'
              ? 'PAYMENT_PROOF_VIEW'
              : 'PAYMENT_PROOF_DOWNLOAD',
        },
      });
    }
    return {
      url,
      expiresAt: new Date(
        issuedAt.getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
      disposition,
      mime: attachment.mime,
      name: attachment.name,
    };
  }
}
