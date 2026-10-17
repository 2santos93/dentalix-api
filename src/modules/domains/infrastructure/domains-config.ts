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
  };
}
