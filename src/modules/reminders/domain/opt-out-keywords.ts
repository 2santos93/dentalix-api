/**
 * Palabras de baja de los recordatorios (DX-128). Un paciente que responde
 * exactamente una de ellas al recordatorio (la conversación de WhatsApp de
 * DX-126) deja de recibir envíos automáticos.
 *
 * Se compara el mensaje ENTERO, ya normalizado: sin tildes, en mayúsculas,
 * sin signos ni emojis y con los espacios colapsados. «No más dolor» o «baja
 * la cita al jueves» no son una baja; «¡Baja!», «stop», «No mas» o «NOMAS»
 * sí. Ante la duda entre estas variantes se respeta la baja: seguir
 * escribiendo a quien pidió parar es peor que dejar de recordarle una cita.
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'BAJA',
  'STOP',
  'NO MAS',
  'NOMAS',
]);

/** Mayúsculas, sin tildes, solo letras/dígitos y espacios simples. */
export function normalizeReplyText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPT_OUT_KEYWORDS.has(normalizeReplyText(text));
}
