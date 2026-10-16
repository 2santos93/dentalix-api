import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { INVITATION_NOTIFIER } from '../../domain/ports/invitation-notifier.port';
import type { InvitationNotifier } from '../../domain/ports/invitation-notifier.port';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../invitation-token';
import {
  CreateInvitationResult,
  INVITATION_TTL_MS,
} from './create-invitation.use-case';

const NOT_PENDING = 'No encontramos una invitación pendiente con ese id.';

export interface ResendInvitationInput {
  id: string;
  /** Origen público de la web de la clínica, para el enlace del email. */
  linkBase: string;
}

/**
 * «Reenviar invitación» (DX-088): la MISMA invitación (mismo id, rol y
 * correo) con un token nuevo y 7 días más desde ahora. El token anterior se
 * sobrescribe, así que su enlace deja de servir; su email, si seguía
 * pendiente, se cancela. Vale también para una invitación caducada.
 */
@Injectable()
export class ResendInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
    @Inject(INVITATION_NOTIFIER)
    private readonly notifier: InvitationNotifier,
  ) {}

  async execute(input: ResendInvitationInput): Promise<CreateInvitationResult> {
    const pending = await this.repo.findPendingById(input.id);
    if (!pending) {
      throw new NotFoundException(NOT_PENDING);
    }
    // Topes anti-abuso antes de regenerar: con 429 el enlace vigente sigue
    // valiendo.
    await this.notifier.assertCanSend(pending.email);

    const token = generateInvitationToken();
    const invitation = await this.repo.reissue(input.id, {
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    if (!invitation) {
      // Otra clínica (RLS), aceptada, revocada o inexistente: nada que reenviar.
      throw new NotFoundException(NOT_PENDING);
    }

    const emailDelivery = await this.notifier.sendInvitation({
      invitation,
      token,
      linkBase: input.linkBase,
    });
    return { invitation, token, emailDelivery };
  }
}
