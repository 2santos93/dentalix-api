import { ClinicInvitation } from '../../../domain/entities/clinic-invitation.entity';
import {
  InvitationEmailDelivery,
  InvitationNotifier,
} from '../../../domain/ports/invitation-notifier.port';

/** Registra lo que se le pide; `failNext` simula que no se pudo encolar. */
export class FakeInvitationNotifier implements InvitationNotifier {
  readonly sent: Array<{
    invitation: ClinicInvitation;
    token: string;
    linkBase: string;
  }> = [];
  readonly cancelled: string[] = [];
  failNext = false;

  sendInvitation(input: {
    invitation: ClinicInvitation;
    token: string;
    linkBase: string;
  }): Promise<InvitationEmailDelivery | null> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve(null);
    }
    this.sent.push(input);
    return Promise.resolve('PENDING');
  }

  cancelPending(invitationId: string): Promise<void> {
    this.cancelled.push(invitationId);
    return Promise.resolve();
  }
}
