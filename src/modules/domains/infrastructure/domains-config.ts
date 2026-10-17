import {
  DEFAULT_RECHECK_MAX_FAILURES,
  RECHECK_MAX_FAILURES_LIMIT,
} from '../domain/rules/tenant-domain-rules';

export const DOMAINS_CONFIG = Symbol('DOMAINS_CONFIG');

export interface DomainsConfig {
  /**
   * Comprobaciones horarias fallidas SEGUIDAS (sin el TXT de verificación)
   * tras las que un dominio VERIFIED pasa a DISABLED y deja de enrutar.
   * `DOMAIN_RECHECK_MAX_FAILURES`, 1..20, default 3.
   */
  recheckMaxFailures: number;
  /**
   * DX-220 (OPS-033): timeout de cada intento del resolver DNS propio, en ms.
   * `DNS_RESOLVER_TIMEOUT_MS`, 100..30000, default 3000.
   */
  dnsTimeoutMs: number;
  /**
   * Intentos por servidor antes de rendirse. `DNS_RESOLVER_TRIES`, 1..5,
   * default 2: una consulta a un DNS que no responde tarda como mucho
   * timeout × intentos (unos 6 s).
   */
  dnsTries: number;
}

export const DEFAULT_DNS_TIMEOUT_MS = 3000;
export const DEFAULT_DNS_TRIES = 2;
export const DNS_TIMEOUT_MS_RANGE = [100, 30_000] as const;
export const DNS_TRIES_RANGE = [1, 5] as const;

function intIn(
  raw: string | undefined,
  [min, max]: readonly [number, number],
  fallback: number,
): number {
  const value = raw?.trim();
  if (!value || !/^\d{1,6}$/.test(value)) return fallback;
  const n = Number(value);
  return n >= min && n <= max ? n : fallback;
}

/** A partir del entorno ya validado por `validateEnv` (env.validation.ts). */
export function loadDomainsConfig(
  get: (key: string) => string | undefined,
): DomainsConfig {
  const raw = get('DOMAIN_RECHECK_MAX_FAILURES')?.trim();
  const value = raw && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return {
    recheckMaxFailures:
      value >= 1 && value <= RECHECK_MAX_FAILURES_LIMIT
        ? value
        : DEFAULT_RECHECK_MAX_FAILURES,
    dnsTimeoutMs: intIn(
      get('DNS_RESOLVER_TIMEOUT_MS'),
      DNS_TIMEOUT_MS_RANGE,
      DEFAULT_DNS_TIMEOUT_MS,
    ),
    dnsTries: intIn(
      get('DNS_RESOLVER_TRIES'),
      DNS_TRIES_RANGE,
      DEFAULT_DNS_TRIES,
    ),
  };
}
