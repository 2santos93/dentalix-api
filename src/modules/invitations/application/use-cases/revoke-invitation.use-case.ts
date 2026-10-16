import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { INVITATION_NOTIFIER } from '../../domain/ports/invitation-notifier.port';
import type { InvitationNotifier } from '../../domain/ports/invitation-notifier.port';

@Injectable()
export class RevokeInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
    @Inject(INVITATION_NOTIFIER)
    private readonly notifier: InvitationNotifier,
  ) {}

  async execute(id: string): Promise<void> {
    // `revokeById` only affects PENDING invitations, so a `false` here
    // covers both "no such id" and "exists but already accepted/revoked" —
    // either way, there's nothing left to revoke.
    const revoked = await this.repo.revokeById(id);
    if (!revoked) {
      throw new NotFoundException('Invitation not found');
    }
    // El email pendiente llevaría un enlace revocado (DX-088).
    await this.notifier.cancelPending(id);
  }
}
