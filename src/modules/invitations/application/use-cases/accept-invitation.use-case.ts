import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AccountClaimConflictError,
  INVITATION_REPOSITORY,
} from '../../domain/ports/invitation-repository.port';
import type {
  AcceptUserResolution,
  InvitationRepository,
} from '../../domain/ports/invitation-repository.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
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

/** Motivo del evento de auditoría al reclamar una cuenta no verificada. */
export const ACCOUNT_CLAIM_AUDIT_REASON = 'INVITATION_ACCOUNT_CLAIM';

export interface AcceptInvitationInput {
  token: string;
  password: string;
  /** Para la auditoría del reclamo de cuenta (DX-029). */
  meta?: {
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  };
}

function assertNewPassword(password: string): void {
  if (!password || password.length < 8) {
    throw new BadRequestException(
      'La contraseña debe tener al menos 8 caracteres.',
    );
  }
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
  private readonly logger = new Logger('Invitations');

  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: RecordAuditEventUseCase,
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

    // DX-029 (SEC-007). El token solo llega por email (nunca al ADMIN que
    // invita), así que quien lo abre controla ese buzón:
    // - sin cuenta → se crea con el email verificado;
    // - cuenta VERIFICADA → hay que demostrar su contraseña (si la olvidó,
    //   la recupera por email: DX-010);
    // - cuenta SIN verificar (pudo crearla alguien sin acceso al email) → si
    //   trae su contraseña actual se une y queda verificada; si trae otra, la
    //   RECLAMA: contraseña nueva, sesiones y enlaces previos invalidados y
    //   evento de auditoría.
    let resolution: AcceptUserResolution;
    if (existingUser) {
      const passwordMatches = await this.password.verify(
        input.password,
        existingUser.passwordHash,
      );
      if (passwordMatches) {
        resolution = { existingUserId: existingUser.id };
      } else if (existingUser.emailVerifiedAt) {
        throw new UnauthorizedException(
          'La contraseña no es correcta. Usa la de tu cuenta de Dentalix o recupérala desde «¿Olvidaste tu contraseña?».',
        );
      } else {
        assertNewPassword(input.password);
        resolution = {
          claim: {
            userId: existingUser.id,
            passwordHash: await this.password.hash(input.password),
          },
        };
      }
    } else {
      assertNewPassword(input.password);
      resolution = {
        newUser: {
          fullName: invitation.fullName,
          passwordHash: await this.password.hash(input.password),
        },
      };
    }

    let outcome: Awaited<
      ReturnType<InvitationRepository['acceptTransactional']>
    >;
    try {
      outcome = await this.repo.acceptTransactional({
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        user: resolution,
      });
    } catch (err) {
      if (err instanceof AccountClaimConflictError) {
        throw new ConflictException(
          'Tu cuenta cambió mientras aceptabas. Vuelve a abrir el enlace e inténtalo de nuevo.',
        );
      }
      throw err;
    }
    const { userId, tokenVersion } = outcome;

    if ('claim' in resolution) {
      this.logger.log({
        event: 'invitation.account_claimed',
        tenantId,
        userId,
        invitationId: invitation.id,
      });
      await this.audit.record({
        tenantId,
        locationId: null,
        actor: { kind: 'user', userId, role: invitation.role },
        action: 'PASSWORD_RESET',
        resourceType: 'SESSION',
        resourceId: null,
        patient: null,
        requestId: input.meta?.requestId ?? null,
        ip: input.meta?.ip ?? null,
        userAgent: input.meta?.userAgent ?? null,
        metadata: { reason: ACCOUNT_CLAIM_AUDIT_REASON },
      });
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
