const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapa texto para el cuerpo o un atributo entre comillas de un HTML. TODA
 * variable de una plantilla pasa por aquí: el nombre de la clínica o del
 * invitado lo escribe un usuario y no puede inyectar marcado en el email.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Una URL solo entra a un `href`/`src` si es http(s) absoluta: un
 * `javascript:` o `data:` nunca llega al email aunque alguien lo cuele como
 * enlace o logo. Devuelve la URL normalizada o `null`.
 */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Texto de una sola línea para el asunto o la versión de texto: sin saltos ni
 * caracteres de control (un salto en el asunto sería inyección de cabeceras
 * si un proveedor no lo saneara).
 */
export function singleLine(value: string): string {
  // \p{Cc}: controles C0 y C1 (U+0080–U+009F) y DEL; más los separadores
  // de línea y párrafo Unicode (U+2028/U+2029).
  return value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
