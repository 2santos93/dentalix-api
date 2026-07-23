type Headers = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(',')[0]?.trim() || undefined;
}

/**
 * Chooses the effective host for tenant resolution. The X-Tenant-Host dev
 * override is honored only outside production; X-Forwarded-Host only behind a
 * trusted proxy. Otherwise the Host header is used.
 */
export function selectHost(
  headers: Headers,
  opts: { isProd: boolean; trustProxy: boolean },
): string | undefined {
  if (!opts.isProd) {
    const override = first(headers['x-tenant-host']);
    if (override) return override;
  }
  if (opts.trustProxy) {
    const forwarded = first(headers['x-forwarded-host']);
    if (forwarded) return forwarded;
  }
  return first(headers['host']);
}
