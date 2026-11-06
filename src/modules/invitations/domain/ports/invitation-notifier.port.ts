import type { Prisma } from '@prisma/client';
import { ClinicInvitation } from '../entities/clinic-invitation.entity';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/** Estado del envío tal como lo ve quien invita (DX-088). */
export type InvitationEmailDelivery = 'PENDING' | 'SENT' | 'FAILED';

/** DX-149-bis: el email de una invitación, listo para la transacción de quien la reemite. */
export interface PreparedInvitationEmail {
  /**
   * En la transacción `tx`: encola el email con los topes contados bajo
   * candado. Si se superan, lanza el mismo 429 que `assertCanSend` y la
   * transacción se deshace entera. Uno por transacción (email-quota-lock).
   */
  insert(tx: Prisma.TransactionClient): Promise<void>;
  /** Despierta al despachador: solo tras el COMMIT. */
  kick(): void;
}

/** Lo que el email necesita de la invitación (aún sin crear, en el alta). */
export type InvitationEmailTarget = Pick<
  ClinicInvitation,
  'id' | 'tenantId' | 'email' | 'fullName' | 'role'
>;

export interface InvitationNotifier {
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
    invitation: InvitationEmailTarget;
    token: string;
    linkBase: string;
  }): Promise<PreparedInvitationEmail | null>;

  /**
   * DX-149-bis: cancela, en la transacción `tx`, los emails aún pendientes de
   * esas invitaciones (revocadas o con el token sobrescrito): su enlace ya no
   * sirve y nunca debe salir.
   */
  cancelPendingInTx(
    tx: Prisma.TransactionClient,
    invitationIds: string[],
  ): Promise<void>;

  /** Cancela los emails aún pendientes de la invitación (revocada o reemplazada). */
  cancelPending(invitationId: string): Promise<void>;
}
