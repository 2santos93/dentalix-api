import { BadRequestException } from '@nestjs/common';
import type { FileStoragePort, StoredObjectInfo } from './file-storage.port';
import { sha256HexToBase64 } from './upload-names';

/**
 * Comprobación común de una subida directa pendiente (DX-259 para los
 * documentos del paciente, reutilizada por los soportes de gastos, DX-274):
 * el objeto está, es de ESTE usuario y su tamaño y SHA-256 son los declarados
 * al autorizar la subida. El tipo por contenido y el movimiento a la clave
 * definitiva los hace cada módulo con su lista blanca.
 */
export const UPLOAD_NOT_FOUND_MESSAGE =
  'No encontramos el archivo subido o la subida caducó. Vuelve a subirlo.';
export const SIZE_MISMATCH_MESSAGE =
  'El tamaño del archivo subido no coincide con el declarado. Vuelve a subirlo.';
export const CHECKSUM_MISMATCH_MESSAGE =
  'El archivo subido no coincide con su huella SHA-256. Vuelve a subirlo.';
export const UPLOAD_CHANGED_MESSAGE =
  'El archivo cambió mientras se comprobaba. Vuelve a subirlo.';
export const EMPTY_FILE_MESSAGE = 'El archivo está vacío.';

/** Metadatos `x-amz-meta-*` que fija la API en todo objeto pendiente. */
export const PENDING_META = {
  uploadedBy: 'uploaded-by',
  size: 'declared-size',
  sha256: 'sha256',
} as const;

export type PendingUploadCheck =
  | { ok: true; info: StoredObjectInfo; declaredSha: string }
  /** Caducado, nunca subido o de otro: no se toca (ni se dice cuál). */
  | { ok: false; reason: 'NOT_FOUND' }
  /** El contenido no vale: quien llama borra el pendiente y lanza `error`. */
  | { ok: false; reason: 'REJECTED'; error: BadRequestException };

export interface PendingUploadRules {
  /** Tope de tamaño en bytes. */
  maxBytes: number;
  tooLargeMessage: string;
  /** ¿Es de quien pide completarla? (autor y lo que más ate el módulo). */
  isOwner(metadata: Record<string, string>): boolean;
  /** El 400 de un contenido vacío o demasiado grande (cada módulo da su código). */
  contentRejected(message: string): BadRequestException;
}

export async function checkPendingUpload(
  storage: FileStoragePort,
  pendingKey: string,
  rules: PendingUploadRules,
): Promise<PendingUploadCheck> {
  const info = await storage.stat(pendingKey);
  if (!info || !rules.isOwner(info.metadata)) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  const rejected = (error: BadRequestException): PendingUploadCheck => ({
    ok: false,
    reason: 'REJECTED',
    error,
  });
  if (info.size === 0)
    return rejected(rules.contentRejected(EMPTY_FILE_MESSAGE));
  if (info.size > rules.maxBytes) {
    return rejected(rules.contentRejected(rules.tooLargeMessage));
  }
  if (String(info.size) !== info.metadata[PENDING_META.size]) {
    return rejected(new BadRequestException(SIZE_MISMATCH_MESSAGE));
  }
  const declaredSha = info.metadata[PENDING_META.sha256] ?? '';
  if (
    !/^[0-9a-f]{64}$/.test(declaredSha) ||
    info.sha256Base64 !== sha256HexToBase64(declaredSha)
  ) {
    return rejected(new BadRequestException(CHECKSUM_MISMATCH_MESSAGE));
  }
  return { ok: true, info, declaredSha };
}
