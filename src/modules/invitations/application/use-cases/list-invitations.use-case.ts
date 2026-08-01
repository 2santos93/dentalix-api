import { Inject, Injectable } from '@nestjs/common';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import {
  ClinicInvitation,
  InvitationStatus,
} from '../../domain/entities/clinic-invitation.entity';
import { invitationStatus } from '../invitation-token';

@Injectable()
export class ListInvitationsUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
  ) {}

  async execute(): Promise<
    Array<ClinicInvitation & { status: InvitationStatus }>
  > {
    // `listPending` already excludes accepted/revoked rows — the status
    // computed here is really just VALID vs. EXPIRED (a pending invite whose
    // 7-day window ran out but nobody has revoked it yet).
    const invitations = await this.repo.listPending();
    const now = new Date();
    return invitations.map((invitation) => ({
      ...invitation,
      status: invitationStatus(invitation, now),
    }));
  }
}
