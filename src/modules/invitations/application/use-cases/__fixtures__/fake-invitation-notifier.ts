import type { Prisma } from '@prisma/client';
import {
  InvitationEmailTarget,
  InvitationNotifier,
  PreparedInvitationEmail,
} from '../../../domain/ports/invitation-notifier.port';

/** Registra lo que se le pide; `failNext` simula que no se pudo encolar. */
export class FakeInvitationNotifier implements InvitationNotifier {
  readonly sent: Array<{
    invitation: InvitationEmailTarget;
    token: string;
    linkBase: string;
  }> = [];
  readonly cancelled: string[] = [];
  failNext = false;
  readonly quotaChecks: string[] = [];
  /** Si se pone, `assertCanSend` lanza este error (tope alcanzado). */
  quotaError: Error | null = null;
  /**
   * DX-149-bis: si se pone, el `insert` en la transacción lanza este error
   * (el tope contado bajo candado lo agotó otra petición a la vez).
   */
  insertError: Error | null = null;
  /** Emails despertados tras el COMMIT. */
  kicked = 0;

  assertCanSend(email: string): Promise<void> {
    this.quotaChecks.push(email);
    return this.quotaError
      ? Promise.reject(this.quotaError)
      : Promise.resolve();
  }

  cancelPendingInTx(
    _tx: Prisma.TransactionClient,
    invitationIds: string[],
  ): Promise<void> {
    this.cancelled.push(...invitationIds);
    return Promise.resolve();
  }

  /** `failNext` también hace que no se pueda preparar (devuelve `null`). */
  prepareInvitation(input: {
    invitation: InvitationEmailTarget;
    token: string;
    linkBase: string;
  }): Promise<PreparedInvitationEmail | null> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve(null);
    }
    return Promise.resolve({
      insert: () => {
        if (this.insertError) return Promise.reject(this.insertError);
        this.sent.push(input);
        return Promise.resolve();
      },
      kick: () => {
        this.kicked += 1;
      },
    });
  }

  cancelPending(invitationId: string): Promise<void> {
    this.cancelled.push(invitationId);
    return Promise.resolve();
  }
}
