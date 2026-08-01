import { Inject, Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';
import {
  hashInvitationToken,
  invitationStatus,
  maskEmail,
} from '../invitation-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

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
    private readonly tenantContext: TenantContextService,
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
  ) {}

  async execute(token: string): Promise<GetInvitationResult> {
    // The host is the only source of tenant identity here (no JWT on a
    // public route) — see PublicTenantContextInterceptor /
    // GetTenantBrandingUseCase. An apex/unknown host never puts a tenant in
    // context, so there's nothing to look up — checked FIRST, before any
    // repo call, so it can't hit `runWithTenant`'s "No tenant in context"
    // plain Error (which Nest would surface as a 500). Returned as data
    // (`NOT_FOUND`), not thrown, to honor this use case's "never throws"
    // contract.
    if (!this.tenantContext.getTenantId()) {
      return { status: 'NOT_FOUND' };
    }

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
