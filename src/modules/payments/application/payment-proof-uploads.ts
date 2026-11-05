import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { StorageObjectChangedError } from '../../../shared/storage/storage-errors';
import {
  UPLOAD_STORAGE_BUDGET_MS,
  withStorageBudget,
} from '../../../shared/storage/storage-budget';
import { currentRequestId } from '../../../shared/observability/request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { TYPE_MISMATCH_MESSAGE } from '../../../shared/storage/document-content';
import {
  EMPTY_FILE_MESSAGE,
  PENDING_META,
  UPLOAD_CHANGED_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
  checkPendingUpload,
} from '../../../shared/storage/pending-upload';
import {
  isSha256Hex,
  normalizeOriginalName,
  sha256HexToBase64,
} from '../../../shared/storage/upload-names';
import {
  MAX_PAYMENT_PROOF_BYTES,
  PROOF_REJECTED_CODE,
  PROOF_TOO_LARGE_MESSAGE,
  PROOF_TYPE_MESSAGE,
  type PaymentProofAttachment,
  declaredLooksLikeProof,
  declaredMatchesDetected,
  pendingProofKey,
  proofStorageKey,
  sniffProofFrom,
} from '../domain/payment-proof';
import { PAYMENT_PROOF_UPLOAD_TTL } from './payment-proof-tokens';

export const INVALID_PROOF_SIZE_MESSAGE =
  'El tamaño del comprobante no es válido.';
export const INVALID_PROOF_SHA256_MESSAGE =
  'La huella SHA-256 del comprobante no es válida.';

/** Metadatos `x-amz-meta-*` que fija la API en el objeto pendiente. */
const META = {
  ...PENDING_META,
  mime: 'declared-mime',
  name: 'file-name',
} as const;

/** Lo que declara el navegador al pedir la subida directa. */
export interface ProofUploadRequest {
  name?: string;
  mimeType?: string;
  size?: number;
  /** SHA-256 del contenido en hex. */
  sha256?: string;
}

export interface ProofUploadTicket {
  uploadId: string;
  target: {
    method: 'POST';
    url: string;
    fields: Record<string, string>;
    expiresAt: string;
  };
  maxBytes: number;
}

/** El comprobante ya comprobado y copiado a su clave definitiva. */
export interface CompletedProof {
  attachment: PaymentProofAttachment;
  /** El objeto pendiente: se borra cuando la fila ya existe. */
  pendingKey: string;
}

function contentRejected(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: PROOF_REJECTED_CODE,
    message,
  });
}

function decodeName(raw: string | undefined): string {
  try {
    return normalizeOriginalName(decodeURIComponent(raw ?? ''));
  } catch {
    return normalizeOriginalName('');
  }
}

/**
 * Subida directa del comprobante de un abono (DX-389): la MISMA
 * infraestructura que el soporte de un gasto (DX-259 aplicado a DX-274) y los
 * documentos del paciente (DX-151): el navegador sube al bucket privado con un
 * POST prefirmado, la API comprueba tamaño, huella y tipo por contenido y copia
 * el objeto a su clave definitiva. Solo cambian la lista blanca (JPG, PNG, WebP
 * y PDF), el tope (10 MB) y el prefijo (`payment-proofs/`).
 */
@Injectable()
export class PaymentProofUploads {
  private readonly logger = new Logger('PaymentProofs');

  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_PROOF_UPLOAD_TTL) private readonly ttlSeconds: number,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Autoriza UNA subida: tamaño de 1 B a 10 MB, huella SHA-256 declarada (el
   * almacén rechaza otro contenido) y una etiqueta que no descarte ya una
   * imagen o un PDF. La clave la fija la API; autor y huella quedan firmados.
   */
  async authorize(
    request: ProofUploadRequest,
    uploadedById: string,
  ): Promise<ProofUploadTicket> {
    const size = request.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new BadRequestException(INVALID_PROOF_SIZE_MESSAGE);
    }
    if (size > MAX_PAYMENT_PROOF_BYTES) {
      throw new BadRequestException(PROOF_TOO_LARGE_MESSAGE);
    }
    if (size === 0) throw new BadRequestException(EMPTY_FILE_MESSAGE);
    if (!isSha256Hex(request.sha256)) {
      throw new BadRequestException(INVALID_PROOF_SHA256_MESSAGE);
    }
    const sha256 = request.sha256.trim().toLowerCase();
    if (
      !declaredLooksLikeProof({
        mimeType: request.mimeType,
        name: request.name,
      })
    ) {
      throw new BadRequestException(PROOF_TYPE_MESSAGE);
    }

    const uploadId = randomUUID();
    const mime = /^[a-z0-9.+/-]{1,100}$/i.test(request.mimeType ?? '')
      ? (request.mimeType ?? '').toLowerCase()
      : '';
    const target = await this.storage.createDirectUpload(
      pendingProofKey(this.tenantId(), uploadId),
      {
        maxBytes: MAX_PAYMENT_PROOF_BYTES,
        sha256Base64: sha256HexToBase64(sha256),
        metadata: {
          [META.uploadedBy]: uploadedById,
          [META.size]: String(size),
          [META.sha256]: sha256,
          ...(mime ? { [META.mime]: mime } : {}),
          // ASCII: el nombre (con tildes, etc.) viaja codificado.
          [META.name]: encodeURIComponent(
            normalizeOriginalName(request.name ?? ''),
          ),
        },
        ttlSeconds: this.ttlSeconds,
      },
    );
    return {
      uploadId,
      target: {
        method: target.method,
        url: target.url,
        fields: target.fields,
        expiresAt: target.expiresAt.toISOString(),
      },
      maxBytes: MAX_PAYMENT_PROOF_BYTES,
    };
  }

  /**
   * El navegador ya dejó el fichero en `pending/<tenant>/<uploadId>`.
   * stat (de ESTE usuario; si no, 404 sin tocarlo) → tamaño → SHA-256 → tipo
   * por contenido (leyendo con `Range`) → `copyVersion` a su clave definitiva.
   * Si el contenido no vale, el objeto se borra y la respuesta es 400 en
   * español. El pendiente NO se borra aquí: quien crea la fila lo descarta
   * después (`discard`).
   */
  complete(uploadId: string, uploadedById: string): Promise<CompletedProof> {
    return withStorageBudget(UPLOAD_STORAGE_BUDGET_MS, () =>
      this.completeWithin(uploadId, uploadedById),
    );
  }

  private async completeWithin(
    uploadId: string,
    uploadedById: string,
  ): Promise<CompletedProof> {
    const tenantId = this.tenantId();
    const pendingKey = pendingProofKey(tenantId, uploadId);
    const reject = async (error: BadRequestException): Promise<never> => {
      await this.discard(pendingKey);
      throw error;
    };

    const checked = await checkPendingUpload(this.storage, pendingKey, {
      maxBytes: MAX_PAYMENT_PROOF_BYTES,
      tooLargeMessage: PROOF_TOO_LARGE_MESSAGE,
      // De otro usuario, caducado o nunca subido: no se toca (ni se dice cuál).
      isOwner: (meta) => meta[META.uploadedBy] === uploadedById,
      contentRejected,
    });
    if (!checked.ok && checked.reason === 'NOT_FOUND') {
      throw new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE);
    }
    if (!checked.ok) return reject(checked.error);
    const { info, declaredSha } = checked;

    const name = decodeName(info.metadata[META.name]);
    let detected;
    try {
      detected = await sniffProofFrom({
        size: info.size,
        read: (start, end) =>
          this.storage.readRange(pendingKey, start, end, info.etag),
      });
    } catch (error) {
      if (error instanceof StorageObjectChangedError) {
        return reject(new BadRequestException(UPLOAD_CHANGED_MESSAGE));
      }
      throw error;
    }
    if (!detected) return reject(contentRejected(PROOF_TYPE_MESSAGE));
    if (
      !declaredMatchesDetected(
        { mimeType: info.metadata[META.mime], name },
        detected,
      )
    ) {
      return reject(contentRejected(TYPE_MISMATCH_MESSAGE));
    }

    // Cada intento posee su propio destino: su cleanup nunca puede borrar la
    // copia de otra transacción que todavía no haya confirmado su fila.
    const key = proofStorageKey(tenantId, randomUUID(), detected, declaredSha);
    try {
      await this.storage.copyVersion(pendingKey, key, detected, info.etag);
    } catch (error) {
      if (error instanceof StorageObjectChangedError) {
        return reject(new BadRequestException(UPLOAD_CHANGED_MESSAGE));
      }
      throw error;
    }
    return {
      attachment: {
        uploadId,
        key,
        mime: detected,
        size: info.size,
        sha256: declaredSha,
        name,
      },
      pendingKey,
    };
  }

  /**
   * Borra un objeto que no tiene (ni tendrá) fila: el pendiente ya adjuntado
   * o el definitivo de un abono que falló. Best-effort: si también falla, se
   * avisa solo con el request id y el ciclo de vida del bucket recoge los
   * pendientes a las 24 h.
   */
  async discard(key: string): Promise<void> {
    try {
      // Excepción justificada al borrado blando: borra un OBJETO del bucket
      // sin fila, no una fila de la BD.
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar un objeto de comprobante (requestId=${currentRequestId() ?? '-'}, error=${error instanceof Error ? error.name : 'NonError'})`,
      );
    }
  }
}
