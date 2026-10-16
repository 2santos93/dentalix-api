import { ClinicInvitation } from '../entities/clinic-invitation.entity';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/** Estado del envío tal como lo ve quien invita (DX-088). */
export type InvitationEmailDelivery = 'PENDING' | 'SENT' | 'FAILED';

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

  /** Cancela los emails aún pendientes de la invitación (revocada o reemplazada). */
  cancelPending(invitationId: string): Promise<void>;
}
