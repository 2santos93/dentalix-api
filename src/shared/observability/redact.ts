export const REDACTED = '[REDACTED]';

/**
 * Claves cuyo valor nunca llega al log (DX-023): credenciales de la petición
 * (Authorization, Cookie, Set-Cookie) y cualquier contraseña, token, secreto o
 * clave de API, se llame como se llame (`refreshToken`, `currentPassword`...).
 * SEC-049: y el nº de afiliado de una cobertura, que es un dato personal.
 * DX-470: y el triaje de una urgencia (señales y nota), que es de salud.
 */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|password|token|secret|api[-_]?key|member[-_]?number|triage/i;

/** Copia de `value` con los valores sensibles reemplazados por `[REDACTED]`. */
export function redactSensitive(value: unknown): unknown {
  return redact(value, []);
}

function redact(value: unknown, seen: object[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.includes(value)) return '[Circular]';
  // `seen` son los ancestros: un objeto repetido en dos ramas no es un ciclo.
  seen.push(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => redact(item, seen));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
    }
    out = copy;
  }
  seen.pop();
  return out;
}
