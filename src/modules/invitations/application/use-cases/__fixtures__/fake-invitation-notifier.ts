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
  readonly quotaChecks: string[] = [];
  /** Si se pone, `assertCanSend` lanza este error (tope alcanzado). */
  quotaError: Error | null = null;

  assertCanSend(email: string): Promise<void> {
    this.quotaChecks.push(email);
    return this.quotaError
      ? Promise.reject(this.quotaError)
      : Promise.resolve();
  }

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
