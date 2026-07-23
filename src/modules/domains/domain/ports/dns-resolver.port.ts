export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

export interface DnsResolver {
  /** Returns the flattened TXT record strings for `name`, or [] if none. */
  resolveTxt(name: string): Promise<string[]>;
}
