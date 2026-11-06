import type { Prisma } from '@prisma/client';
import { ClinicInvitation } from '../entities/clinic-invitation.entity';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/** Estado del envío tal como lo ve quien invita (DX-088). */
export type InvitationEmailDelivery = 'PENDING' | 'SENT' | 'FAILED';

/** DX-149-bis: el email de una invitación, listo para la transacción de quien la reemite. */
export interface PreparedInvitationEmail {
  /**
   * En la transacción `tx`: cancela el email pendiente del enlace anterior y
   * encola el nuevo con los topes contados bajo candado. Si se superan, lanza
   * el mismo 429 que `assertCanSend` y la transacción se deshace entera.
   */
  insert(tx: Prisma.TransactionClient): Promise<void>;
  /** Despierta al despachador: solo tras el COMMIT. */
  kick(): void;
}

export interface InvitationNotifier {
  /**
   * Encola el email con el enlace de aceptación `${linkBase}/invitacion/<token>`
   * y cancela el que quedara pendiente con un enlace anterior. NUNCA lanza:
   * si no se pudo encolar devuelve `null` (la invitación sigue valiendo y el
   * ADMIN tiene el enlace para compartirlo o puede reenviarla).
   */
  sendInvitation(input: {
    invitation: ClinicInvitation;
    token: string;
    linkBase: string;
  }): Promise<InvitationEmailDelivery | null>;

  /**
   * Topes anti-abuso del email (DX-088, revisión B1) para `email` en la
   * clínica en contexto. Se llama ANTES de crear o regenerar nada; si se
   * superan, lanza un 429 con el mensaje en español.
   */
  assertCanSend(email: string): Promise<void>;

  /**
   * DX-149-bis: prepara (marca, cifrado) FUERA de la transacción el email con
   * el enlace `${linkBase}/invitacion/<token>`, para encolarlo dentro de ella.
   * NUNCA lanza: `null` si no se pudo preparar (se reemite sin email).
   */
  prepareInvitation(input: {
    invitation: ClinicInvitation;
    token: string;
    linkBase: string;
  }): Promise<PreparedInvitationEmail | null>;

  /** Cancela los emails aún pendientes de la invitación (revocada o reemplazada). */
  cancelPending(invitationId: string): Promise<void>;
}
