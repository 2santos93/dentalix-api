type EnvReader = (key: string) => string | undefined;

export interface SecuritySettings {
  /**
   * Saltos de proxy en los que confía Express para calcular `req.ip` desde
   * `X-Forwarded-For` (0 = ninguno: se usa la IP del socket). Debe coincidir
   * con la topología real; confiar de más permite falsear la IP.
   */
  trustProxyHops: number;
  corsOrigins: string[];
  corsRootDomain: string;
}

export function loadSecuritySettings(env: EnvReader): SecuritySettings {
  // Misma bandera que usa TenantHostMiddleware para X-Forwarded-Host.
  const trustProxy = env('TRUST_PROXY') === 'true';
  let trustProxyHops = 0;
  if (trustProxy) {
    const raw = env('TRUST_PROXY_HOPS');
    if (raw == null || raw === '') {
      trustProxyHops = 1;
    } else if (/^\d+$/.test(raw) && Number(raw) > 0) {
      trustProxyHops = Number(raw);
    } else {
      throw new Error(
        `Invalid env var TRUST_PROXY_HOPS: expected a positive integer, got "${raw}"`,
      );
    }
  }
  return {
    trustProxyHops,
    // CORS: orígenes explícitos (coma-separados) + cualquier subdominio del
    // dominio raíz (tenants de marca blanca en su subdominio).
    corsOrigins: (env('CORS_ORIGINS') ?? 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    corsRootDomain: env('CORS_ROOT_DOMAIN') ?? 'dentalix.local',
  };
}
