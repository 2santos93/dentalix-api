export const RESERVED_SUBDOMAINS: readonly string[] = [
  'www',
  'api',
  'app',
  'admin',
];

export type ParsedHost =
  | { kind: 'subdomain'; subdomain: string }
  | { kind: 'custom'; host: string }
  | null;

/**
 * Maps a raw request host to either a subdomain (to look up Tenant.subdomain)
 * or a custom domain (to look up a verified TenantDomain). Pure: all config
 * (base domains) is passed in.
 */
export function parseHost(
  rawHost: string | undefined,
  baseDomains: string[],
): ParsedHost {
  if (!rawHost) return null;
  const host = rawHost.trim().toLowerCase().split(':')[0];
  if (!host) return null;

  for (const base of baseDomains) {
    if (host === base) return null; // apex: no subdomain
    if (host.endsWith(`.${base}`)) {
      const subdomain = host.slice(0, host.length - base.length - 1);
      // Only a single left-most label is a valid subdomain.
      if (!subdomain || subdomain.includes('.')) return null;
      if (RESERVED_SUBDOMAINS.includes(subdomain)) return null;
      return { kind: 'subdomain', subdomain };
    }
  }

  return { kind: 'custom', host };
}
