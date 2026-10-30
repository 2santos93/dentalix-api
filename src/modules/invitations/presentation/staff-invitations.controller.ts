import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateInvitationUseCase } from '../application/use-cases/create-invitation.use-case';
import { ListInvitationsUseCase } from '../application/use-cases/list-invitations.use-case';
import { RevokeInvitationUseCase } from '../application/use-cases/revoke-invitation.use-case';
import { ResendInvitationUseCase } from '../application/use-cases/resend-invitation.use-case';
import { CreateInvitationResult } from '../application/use-cases/create-invitation.use-case';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreatedInvitationDto, InvitationDto } from './dto/invitation.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { STAFF_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { invitationStatus } from '../application/invitation-token';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';

type AuthenticatedRequest = TenantHostRequest &
  AuditableRequest & { user: JwtPayload };

// Managing staff invitations is gestión-only, same as staff.controller.ts's
// STAFF_WRITE_ROLES routes — no per-method @Roles override needed since
// every route on this controller is ADMIN-only.
@ApiTags('staff-invitations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...STAFF_WRITE_ROLES)
@Controller('staff/invitations')
export class StaffInvitationsController {
  constructor(
    private readonly createInvitation: CreateInvitationUseCase,
    private readonly listInvitations: ListInvitationsUseCase,
    private readonly revokeInvitation: RevokeInvitationUseCase,
    private readonly resendInvitation: ResendInvitationUseCase,
    private readonly links: TenantLinkBaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * DX-359: quién gestiona la invitación. El repositorio escribe el evento en
   * la transacción de cada escritura (sin token, hash ni email).
   */
  private auditCtx(req: AuthenticatedRequest): AuditRequestContext {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  /**
   * Origen de la web de la clínica para el enlace del email. SEC-033: la
   * invitación puede reclamar una cuenta GLOBAL sin verificar (DX-029), así
   * que el enlace va siempre a un host de plataforma: el de la petición si ya
   * lo es (TenantContextInterceptor lo cruzó con el JWT) o, si llegó por el
   * dominio personalizado de la clínica (DNS de un tercero),
   * `<subdominio>.<dominio base>`. Se resuelve ANTES de tocar nada.
   */
  private async linkBase(req: AuthenticatedRequest): Promise<string> {
    // El del host: TenantContextInterceptor ya exigió que sea el del JWT.
    const tenantId = req.tenantHost?.tenantId;
    const linkBase = tenantId
      ? await this.links.forTenant(tenantId, req.tenantHost?.host)
      : null;
    if (!linkBase) {
      throw new BadRequestException('Host inválido');
    }
    return linkBase;
  }

  private toCreatedDto(result: CreateInvitationResult): CreatedInvitationDto {
    // El token NO sale de aquí (DX-029): solo viaja en el email.
    const { invitation, emailDelivery } = result;
    return {
      ...invitation,
      status: invitationStatus(invitation, new Date()),
      emailDelivery,
    };
  }

  @Post()
  // Cada una manda un email: límite por clínica + usuario (DX-088, B1).
  @RateLimit('invitation-email')
  @ApiOperation({
    summary:
      'Invita a una persona: crea la invitación y encola el email con el enlace (se envía en segundo plano)',
    description:
      'Queda en la auditoría (CREATE de STAFF_INVITATION con el rol; la pendiente que sustituye, como VOID INVITATION_REPLACED).',
  })
  @ApiCreatedResponse({ type: CreatedInvitationDto })
  async create(
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedInvitationDto> {
    const linkBase = await this.linkBase(req);
    const result = await this.createInvitation.execute(
      { ...dto, invitedById: req.user.sub, linkBase },
      this.auditCtx(req),
    );
    return this.toCreatedDto(result);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RateLimit('invitation-email')
  @ApiOperation({
    summary:
      'Reenvía una invitación pendiente: token nuevo (el anterior deja de servir), 7 días más y un email nuevo',
    description:
      'Queda en la auditoría (UPDATE de STAFF_INVITATION, INVITATION_RESENT), sin el token.',
  })
  @ApiOkResponse({ type: CreatedInvitationDto })
  @ApiNotFoundResponse({
    description: 'No hay una invitación pendiente con ese id en esta clínica',
  })
  async resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedInvitationDto> {
    const linkBase = await this.linkBase(req);
    const result = await this.resendInvitation.execute(
      { id, linkBase },
      this.auditCtx(req),
    );
    return this.toCreatedDto(result);
  }

  @Get()
  @ApiOkResponse({ type: [InvitationDto] })
  list(): Promise<InvitationDto[]> {
    return this.listInvitations.execute();
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Retira una invitación pendiente (su enlace deja de servir)',
    description:
      'Queda en la auditoría (VOID de STAFF_INVITATION, INVITATION_REVOKED).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'No hay una invitación pendiente con ese id en esta clínica',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.revokeInvitation.execute(id, this.auditCtx(req));
  }
}
