import { ServiceUnavailableException } from '@nestjs/common';

/** Segundos que se sugieren en `Retry-After` cuando el almacén no responde. */
export const STORAGE_RETRY_AFTER_SECONDS = 5;

export const STORAGE_UNAVAILABLE_MESSAGE =
  'El almacén de archivos no responde. Inténtalo de nuevo en unos minutos.';

/**
 * DX-259 (OPS-039): el almacén no respondió a tiempo (timeout, conexión
 * rechazada o cortada, 5xx del proveedor tras los reintentos). La API responde
 * 503 en español con `Retry-After` (AppExceptionFilter); el `cause` solo se
 * registra por su tipo, nunca su mensaje (podría llevar la clave).
 */
export class StorageUnavailableError extends ServiceUnavailableException {
  constructor(cause?: unknown) {
    super(STORAGE_UNAVAILABLE_MESSAGE, { cause });
    this.name = 'StorageUnavailableError';
  }
}

/**
 * El objeto cambió entre dos lecturas (otra versión con otra ETag): lo que se
 * comprobó ya no es lo que hay. El caso de uso lo trata como contenido que no
 * cuadra.
 */
export class StorageObjectChangedError extends Error {
  constructor() {
    super('El objeto del almacén cambió durante la comprobación.');
    this.name = 'StorageObjectChangedError';
  }
}
