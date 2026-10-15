import { createHash } from 'crypto';

/**
 * Clave del balde `login`: IP + email normalizado. Así la fuerza bruta contra
 * una cuenta se corta sin bloquear a los compañeros de la clínica que salen por
 * la misma IP (NAT). El "spraying" de muchos emails desde una IP lo frena el
 * balde `auth`, que es solo por IP. La clave se hashea para no guardar emails
 * en claro en el almacenamiento del limitador.
 */
export function loginRateLimitKey(
  prefix: string,
  ip: string,
  body: unknown,
): string {
  const email =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { email?: unknown }).email === 'string'
      ? (body as { email: string }).email.trim().toLowerCase()
      : '';
  return createHash('sha256').update(`${prefix}-${ip}-${email}`).digest('hex');
}
