import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import {
  SignatureImageError,
  parseSignaturePng,
} from '../../consents/domain/signature-image';
import {
  receiptContentHash,
  receiptDocumentModel,
  type PublicReceiptView,
} from '../domain/commission-receipt';
import {
  COMMISSION_CLOCK,
  type CommissionClock,
} from '../domain/ports/commission-repository.port';
import {
  COMMISSION_PAYMENT_REPOSITORY,
  type CommissionPaymentRepository,
  type ReceiptEvidence,
  type ReceiptRequestRecord,
} from '../domain/ports/commission-payment-repository.port';
import { receiptSignatureHash } from '../domain/settlement-payments';
import {
  COMMISSION_PDF_RENDERER,
  type CommissionPdfRenderer,
} from '../infrastructure/commission-pdf.renderer';
import type { CommissionPdf } from './commission-payment.use-cases';

export const COMMISSION_RECEIPT_LINK_INVALID_MESSAGE =
  'Este enlace no es válido o ya caducó. Pide a la clínica uno nuevo.';
export const COMMISSION_RECEIPT_SIGNER_MESSAGE =
  'Escribe tu nombre completo (de 2 a 120 caracteres).';
export const COMMISSION_RECEIPT_ALREADY_SIGNED_MESSAGE =
  'Ya firmaste la conformidad de este pago.';

/** Controles C0/C1 (un nombre no los lleva). */
function hasControlChars(text: string): boolean {
  return Array.from(text).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

const invalid = () =>
  new NotFoundException(COMMISSION_RECEIPT_LINK_INVALID_MESSAGE);

/**
 * DX-464: el enlace de conformidad que abre el profesional, sin sesión. El
 * tenant sale del host; un token malformado, desconocido, de otra clínica,
 * revocado, de un pago anulado o caducado da el MISMO 404. Firmado, el enlace
 * ya no se puede volver a firmar (un solo uso), pero hasta que caduque deja
 * ver y descargar la copia firmada.
 */
@Injectable()
export class CommissionReceiptPublicUseCases {
  constructor(
    @Inject(COMMISSION_PAYMENT_REPOSITORY)
    private readonly repo: CommissionPaymentRepository,
    @Inject(COMMISSION_PDF_RENDERER)
    private readonly renderer: CommissionPdfRenderer,
    @Inject(COMMISSION_CLOCK) private readonly now: CommissionClock,
  ) {}

  private async usable(token: string): Promise<ReceiptRequestRecord> {
    if (!isWellFormedPublicLinkToken(token)) throw invalid();
    const record = await this.repo.receiptByToken(hashPublicLinkToken(token));
    if (
      !record ||
      record.revokedAt !== null ||
      record.paymentVoided ||
      record.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw invalid();
    }
    return record;
  }

  private viewOf(record: ReceiptRequestRecord): PublicReceiptView {
    return {
      status: record.signedAt ? 'SIGNED' : 'PENDING',
      content: record.content,
      expiresAt: record.expiresAt,
      signedAt: record.signedAt,
      signerName: record.signerName,
    };
  }

  /** Solo lectura: los previsualizadores de enlaces la abren solos. */
  async get(token: string): Promise<PublicReceiptView> {
    return this.viewOf(await this.usable(token));
  }

  /** La página avisa de que el profesional la abrió (solo la primera vez). */
  async opened(token: string): Promise<void> {
    const record = await this.usable(token);
    if (record.openedAt === null && record.signedAt === null) {
      await this.repo.markReceiptOpened(record.id);
    }
  }

  async sign(
    token: string,
    input: { signerName: string; signature: string; accepted: boolean },
    evidence: ReceiptEvidence,
  ): Promise<PublicReceiptView> {
    const record = await this.usable(token);
    if (record.signedAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'COMMISSION_RECEIPT_ALREADY_SIGNED',
        message: COMMISSION_RECEIPT_ALREADY_SIGNED_MESSAGE,
      });
    }
    // La foto guardada tiene que seguir casando con su huella.
    if (receiptContentHash(record.content) !== record.contentHash) {
      throw invalid();
    }
    const signerName = (input.signerName ?? '').trim().replace(/\s+/g, ' ');
    const length = Array.from(signerName).length;
    if (length < 2 || length > 120 || hasControlChars(signerName)) {
      throw new BadRequestException(COMMISSION_RECEIPT_SIGNER_MESSAGE);
    }
    let signature: string;
    try {
      signature = parseSignaturePng(input.signature ?? '', 'la firma');
    } catch (error) {
      if (error instanceof SignatureImageError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const signed = await this.repo.signReceipt(record.id, {
      signerName,
      signature,
      receiptHash: receiptSignatureHash(
        record.contentHash,
        signerName,
        signature,
      ),
      evidence: {
        ipAddress: evidence.ipAddress?.slice(0, 100) ?? null,
        userAgent: evidence.userAgent?.slice(0, 500) ?? null,
      },
      now: this.now(),
    });
    if (!signed) throw invalid();
    return this.viewOf(await this.usable(token));
  }

  /** La copia firmada, mientras el enlace no caduque. */
  async pdf(token: string): Promise<CommissionPdf> {
    const record = await this.usable(token);
    if (
      !record.signedAt ||
      !record.signature ||
      !record.receiptHash ||
      !record.signerName
    ) {
      throw invalid();
    }
    const model = receiptDocumentModel(
      record.content,
      {
        signerName: record.signerName,
        signature: record.signature,
        signedAt: record.signedAt,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        contentHash: record.contentHash,
        receiptHash: record.receiptHash,
      },
      record.content.format.timeZone ?? null,
      this.now(),
    );
    return {
      filename: `recibo-honorarios-${record.content.payment.paidOn}-${record.content.payment.currency}-conforme.pdf`,
      pdf: await this.renderer.render(model),
    };
  }
}
