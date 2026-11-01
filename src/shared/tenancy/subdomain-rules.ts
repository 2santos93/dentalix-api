import { RESERVED_SUBDOMAINS } from './host-parser';

/**
 * Reglas de la dirección web de una clínica (`<subdominio>.dentalix.app`).
 * Las comparten el registro (`RegisterDto`, `RegisterClinicUseCase`) y la
 * comprobación pública de disponibilidad, para que la web nunca vea
 * «Disponible» en algo que el registro rechaza.
 *
 * Formato: una etiqueta DNS (RFC 1123): minúsculas ASCII, cifras y guiones,
 * 1–63 caracteres, sin guion al principio ni al final; y sin `--` en las
 * posiciones 3–4 (RFC 5891: reservado a IDNA, p. ej. `xn--…`, que el
 * navegador pintaría como otra dirección). Sin lookbehind: la web reusa la
 * misma expresión y Safari < 16.4 no lo soporta.
 */
export const SUBDOMAIN_PATTERN_SOURCE =
  '^(?!.{2}--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$';
export const SUBDOMAIN_PATTERN = new RegExp(SUBDOMAIN_PATTERN_SOURCE);
export const SUBDOMAIN_MAX_LENGTH = 63;

export const SUBDOMAIN_FORMAT_MESSAGE =
  'La dirección web solo admite minúsculas sin tildes, números y guiones (sin guion al principio ni al final, máximo 63).';

export type SubdomainRuleVerdict = 'ok' | 'invalid' | 'reserved';

/** Como la escribe el registro: sin espacios y en minúsculas. */
export function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * ¿Se puede registrar `subdomain` (ya normalizado) por su forma? `reserved` =
 * una de las direcciones de la plataforma (`RESERVED_SUBDOMAINS`, las que el
 * router de hosts nunca resuelve a una clínica: registrarla dejaría una
 * clínica inalcanzable).
 */
export function subdomainRuleVerdict(subdomain: string): SubdomainRuleVerdict {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) return 'invalid';
  if (RESERVED_SUBDOMAINS.includes(subdomain)) return 'reserved';
  return 'ok';
}
