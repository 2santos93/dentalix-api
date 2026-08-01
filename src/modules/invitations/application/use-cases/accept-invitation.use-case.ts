import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { hashInvitationToken, invitationStatus } from '../invitation-token';

export interface AcceptInvitationInput {
  token: string;
  password: string;
}

export interface AcceptInvitationResult {
  accessToken: string;
  refreshToken: string;
}

/**
 * Caso de uso PÚBLICO (sin auth): quien acepta todavía no tiene sesión. El
 * `tenantId` del JWT sale del tenant en CONTEXTO (resuelto por el
 * host/subdominio de la petición, igual que cualquier otra ruta pública de
 * tenant) — nunca de la invitación ni del cliente — y el `role` sale de la
 * INVITACIÓN, nunca de `input` (que solo trae `token`+`password`, así que no
 * hay ni vector para colar un rol distinto).
 */
@Injectable()
export class AcceptInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    const invitation = await this.repo.findByTokenHash(
      hashInvitationToken(input.token),
    );
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    const status = invitationStatus(invitation, new Date());
    if (status !== 'VALID') {
      throw new GoneException(`Invitation is ${status.toLowerCase()}`);
    }

    const existingUser = await this.repo.findUserByEmailGlobal(
      invitation.email,
    );

    let userId: string;
    if (existingUser) {
      const passwordMatches = await this.password.verify(
        input.password,
        existingUser.passwordHash,
      );
      if (!passwordMatches) {
        throw new UnauthorizedException('Invalid password');
      }
      // No cambia su contraseña ni crea un usuario nuevo: solo reutiliza la
      // cuenta. `acceptTransactional` crea/reactiva la membresía sin
      // duplicarla si ya era miembro activo (caso 7 del brief).
      const outcome = await this.repo.acceptTransactional({
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        existingUserId: existingUser.id,
      });
      userId = outcome.userId;
    } else {
      if (!input.password || input.password.length < 8) {
        throw new BadRequestException('password must be at least 8 characters');
      }
      const passwordHash = await this.password.hash(input.password);
      const outcome = await this.repo.acceptTransactional({
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        newUser: { fullName: invitation.fullName, passwordHash },
      });
      userId = outcome.userId;
    }

    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }

    // El rol viene de la invitación (`invitation.role`), NUNCA de `input` —
    // que ni siquiera lo acepta.
    return this.tokens.issue({ sub: userId, tenantId, role: invitation.role });
  }
}
