/**
 * Enmascara un correo para mostrarlo (listados, logs, registro de envíos) sin
 * exponerlo completo: conserva hasta 2 caracteres locales + `***` + el dominio
 * tal cual. Un valor sin `@` sale como `***` entero: nunca se devuelve tal cual
 * algo que no se sabe qué es.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return '***';
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 2)}***@${domain}`;
}
