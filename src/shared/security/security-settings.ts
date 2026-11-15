type EnvReader = (key: string) => string | undefined;

export interface SecuritySettings {
  /**
   * Saltos de proxy en los que confía Express para calcular `req.ip` desde
   * `X-Forwarded-For` (0 = ninguno: se usa la IP del socket). Debe coincidir
   * con la topología real; confiar de más permite falsear la IP.
   */
  trustProxyHops: number;
  /** NODE_ENV=production: sin defaults y solo https (SEC-021). */
  production: boolean;
  corsOrigins: string[];
  corsRootDomain: string;
}

/** Defaults SOLO de desarrollo (en producción no hay, SEC-021). */
const DEV_CORS_ORIGIN = 'http://localhost:3001';
const DEV_CORS_ROOT_DOMAIN = 'dentalix.local';

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
  // SEC-021: en producción no hay defaults de desarrollo. validateEnv ya
  // impide arrancar sin ellos (DX-045); esto cubre a quien construya los
  // ajustes con otro lector (tests, scripts) y cierra en vez de abrir.
  const production = env('NODE_ENV') === 'production';
  const corsRootDomain = env('CORS_ROOT_DOMAIN')?.trim().toLowerCase();
  if (production && !corsRootDomain) {
    throw new Error(
      'CORS_ROOT_DOMAIN es obligatorio en producción (SEC-021: sin default).',
    );
  }
  return {
    trustProxyHops,
    production,
    // CORS: orígenes explícitos (coma-separados) + cualquier subdominio del
    // dominio raíz (tenants de marca blanca en su subdominio) + los dominios
    // propios VERIFIED (SEC-021, ver `isAllowedOrigin`).
    corsOrigins: (env('CORS_ORIGINS') ?? (production ? '' : DEV_CORS_ORIGIN))
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    corsRootDomain: corsRootDomain || DEV_CORS_ROOT_DOMAIN,
  };
}

/**
 * Consulta de los dominios propios: ¿es `host` un dominio VERIFIED vivo de una
 * clínica viva? La implementa `VerifiedDomainOrigins` (con caché).
 */
export interface VerifiedDomainLookup {
  isVerified(host: string): Promise<boolean>;
}

/** Origen tal como lo manda el navegador, ya interpretado. */
function parseOrigin(origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // `Origin` es solo `esquema://host[:puerto]`: con ruta, credenciales o en
  // otra forma no es un origen de navegador (y "null" ya no parsea).
  if (url.origin !== origin.toLowerCase() || url.username || url.password) {
    return null;
  }
  return url;
}

/** https y puerto estándar (el navegador omite el 443). */
const isHttpsDefaultPort = (url: URL): boolean =>
  url.protocol === 'https:' && url.port === '';

/**
 * ¿Es `origin` el dominio raíz o uno de sus subdominios, o uno exacto de
 * `CORS_ORIGINS`? Regla estática, sin base de datos. En producción el raíz y
 * sus subdominios solo valen con https y el puerto estándar (SEC-021): un
 * `http://demo.dentalix.app` o `https://demo.dentalix.app:8443` no es la web.
 * Los de `CORS_ORIGINS` son exactos; validateEnv ya exige https en producción.
 */
export function isStaticAllowedOrigin(
  origin: string,
  { corsOrigins, corsRootDomain, production }: SecuritySettings,
): boolean {
  if (corsOrigins.includes(origin)) return true;
  const url = parseOrigin(origin);
  if (!url) return false;
  if (production && !isHttpsDefaultPort(url)) return false;
  return isUnderRoot(url.hostname, corsRootDomain);
}

const isUnderRoot = (host: string, root: string): boolean =>
  host === root || host.endsWith(`.${root}`);

/**
 * Host candidato a dominio propio: https con el puerto estándar y fuera del
 * dominio raíz (esos los decide la regla estática). null si no lo es.
 */
export function customDomainHostOf(
  origin: string,
  { corsRootDomain }: SecuritySettings,
): string | null {
  const url = parseOrigin(origin);
  if (!url || !isHttpsDefaultPort(url)) return null;
  if (isUnderRoot(url.hostname, corsRootDomain)) return null;
  return url.hostname;
}

/**
 * ¿Es `origin` una web de Dentalix? Los de `CORS_ORIGINS` (exactos), el
 * dominio raíz con sus subdominios (clínicas de marca blanca; en producción
 * solo https y puerto estándar) y, SEC-021, los dominios propios VERIFIED con
 * https. Un PENDING, DISABLED o borrado no vale. Es la MISMA regla para CORS
 * (solo estos orígenes reciben `Access-Control-Allow-Credentials`) y para la
 * comprobación de `Origin` del refresh por cookie (CSRF).
 *
 * Sin `verifiedDomains` (apps de test sin base de datos) solo vale la regla
 * estática.
 */
export async function isAllowedOrigin(
  origin: string,
  settings: SecuritySettings,
  verifiedDomains: VerifiedDomainLookup | null,
): Promise<boolean> {
  if (isStaticAllowedOrigin(origin, settings)) return true;
  if (!verifiedDomains) return false;
  const host = customDomainHostOf(origin, settings);
  return host != null && (await verifiedDomains.isVerified(host));
}
