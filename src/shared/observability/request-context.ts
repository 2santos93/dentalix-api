import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
}

/**
 * Contexto de la petición en curso (DX-023). Lo abre el middleware de
 * observabilidad y lo lee el logger, para que TODAS las líneas que se
 * escriban durante la petición lleven su request id sin pasarlo a mano.
 */
export const requestContext = new AsyncLocalStorage<RequestStore>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
