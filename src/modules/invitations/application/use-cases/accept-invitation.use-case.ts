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
import { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';

export const INVITATION_NOT_FOUND =
  'La invitación no existe o el enlace ya no es válido (puede que te hayan enviado uno más reciente).';

const GONE_MESSAGE: Record<Exclude<InvitationStatus, 'VALID'>, string> = {
  EXPIRED: 'La invitación caducó. Pide a la clínica que te la reenvíe.',
  USED: 'Esta invitación ya se usó.',
  REVOKED: 'La clínica revocó esta invitación.',
};

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
    // Checked FIRST, before any repo call: an apex/unknown host never puts a
    // tenant in context (see PublicTenantContextInterceptor /
    // GetTenantBrandingUseCase), so there's nothing to look up. Doing this
    // check late would let `findByTokenHash` reach `runWithTenant`'s "No
    // tenant in context" plain Error first, which Nest surfaces as a 500
    // instead of a clean 404.
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new NotFoundException(INVITATION_NOT_FOUND);
    }

    const invitation = await this.repo.findByTokenHash(
      hashInvitationToken(input.token),
    );
    // Un token reemplazado por «Reenviar invitación» ya no existe (DX-088).
    if (!invitation) {
      throw new NotFoundException(INVITATION_NOT_FOUND);
    }

    const status = invitationStatus(invitation, new Date());
    if (status !== 'VALID') {
      throw new GoneException(GONE_MESSAGE[status]);
    }

    const existingUser = await this.repo.findUserByEmailGlobal(
      invitation.email,
    );

    let userId: string;
    // Versión de sesión con la que nace el par (claim `tv`): la vigente del
    // usuario existente, o 0 para una cuenta recién creada.
    let tokenVersion = 0;
    if (existingUser) {
      const passwordMatches = await this.password.verify(
        input.password,
        existingUser.passwordHash,
      );
      if (!passwordMatches) {
        throw new UnauthorizedException(
          'La contraseña no es correcta. Usa la de tu cuenta de Dentalix.',
        );
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
      tokenVersion = existingUser.tokenVersion;
    } else {
      if (!input.password || input.password.length < 8) {
        throw new BadRequestException(
          'La contraseña debe tener al menos 8 caracteres.',
        );
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

    // El rol viene de la invitación (`invitation.role`), NUNCA de `input` —
    // que ni siquiera lo acepta. `tenantId` ya se validó al principio.
    return this.tokens.issue({
      sub: userId,
      tenantId,
      role: invitation.role,
      tv: tokenVersion,
    });
  }
}
