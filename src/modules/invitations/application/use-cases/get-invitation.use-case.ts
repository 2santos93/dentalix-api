import { Inject, Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';
import { hashInvitationToken, invitationStatus, maskEmail } from '../invitation-token';

export interface GetInvitationResult {
  status: InvitationStatus | 'NOT_FOUND';
  clinicName?: string;
  role?: ClinicRole;
  maskedEmail?: string;
  userExists?: boolean;
}

/**
 * Caso de uso PÚBLICO (sin auth): la pantalla de "aceptar invitación" lo
 * llama antes de saber siquiera si el token es válido. Por eso nunca lanza —
 * cualquier motivo de invalidez (no existe, expiró, se usó, se revocó) se
 * devuelve como dato (`status`), nunca como excepción.
 */
@Injectable()
export class GetInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
  ) {}

  async execute(token: string): Promise<GetInvitationResult> {
    const invitation = await this.repo.findByTokenHash(
      hashInvitationToken(token),
    );
    if (!invitation) {
      return { status: 'NOT_FOUND' };
    }

    const status = invitationStatus(invitation, new Date());
    if (status !== 'VALID') {
      // Deliberately just `{ status }` — expired/used/revoked must not leak
      // clinicName/role/maskedEmail (they're only meaningful for a VALID
      // invitation the person is actually about to accept).
      return { status };
    }

    const [clinicName, existingUser] = await Promise.all([
      this.repo.findTenantName(),
      this.repo.findUserByEmailGlobal(invitation.email),
    ]);

    return {
      status,
      ...(clinicName !== null ? { clinicName } : {}),
      role: invitation.role,
      maskedEmail: maskEmail(invitation.email),
      userExists: existingUser !== null,
    };
  }
}
