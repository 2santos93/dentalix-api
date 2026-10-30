import type { OutboundChannel } from '@prisma/client';
import { maskEmail } from '../../../../shared/privacy/mask-email';

/**
 * Destinatario enmascarado para `outbound_messages` y los logs (DX-085):
 * nunca la dirección ni el número completos.
 * - EMAIL: `an***@dominio` (maskEmail, como email_outbox).
 * - Teléfono: `+NN***4567` (prefijo de 2 dígitos y los 4 últimos). Un número
 *   de menos de 8 dígitos sale `***` entero.
 */
export function maskRecipient(
  channel: OutboundChannel,
  recipient: string,
): string {
  if (channel === 'EMAIL') {
    return maskEmail(recipient.trim());
  }
  const trimmed = recipient.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) {
    return '***';
  }
  const plus = trimmed.startsWith('+') ? '+' : '';
  return `${plus}${digits.slice(0, 2)}***${digits.slice(-4)}`;
}
