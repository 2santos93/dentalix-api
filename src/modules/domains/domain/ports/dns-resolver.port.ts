export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

/**
 * El DNS no pudo responder (SERVFAIL, timeout, conexión rechazada…): no se
 * sabe si el registro existe. Distinto de «no hay registro» (`[]`).
 */
export class DnsLookupError extends Error {
  constructor(readonly code: string) {
    super(`DNS lookup failed (${code})`);
    this.name = 'DnsLookupError';
  }
}

export interface DnsResolver {
  /**
   * Los TXT de `name` (los trozos de cada registro unidos), o `[]` si el
   * nombre no existe o no tiene TXT (NXDOMAIN / NODATA). Lanza
   * `DnsLookupError` si el DNS no pudo responder.
   */
  resolveTxt(name: string): Promise<string[]>;
}
