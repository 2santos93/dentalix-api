type Headers = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(',')[0]?.trim() || undefined;
}

/**
 * Chooses the effective host for tenant resolution. The X-Tenant-Host dev
 * override is honored only outside production; X-Forwarded-Host behind a
 * trusted proxy, and always outside production, where the client can already
 * pick the tenant with X-Tenant-Host: así `next dev` (rewrite de `/api/v1`, que
 * pone X-Forwarded-Host = host de la clínica) funciona sin TRUST_PROXY.
 * Otherwise the Host header is used.
 */
export function selectHost(
  headers: Headers,
  opts: { isProd: boolean; trustProxy: boolean },
): string | undefined {
  if (!opts.isProd) {
    const override = first(headers['x-tenant-host']);
    if (override) return override;
  }
  if (opts.trustProxy || !opts.isProd) {
    const forwarded = first(headers['x-forwarded-host']);
    if (forwarded) return forwarded;
  }
  return first(headers['host']);
}
