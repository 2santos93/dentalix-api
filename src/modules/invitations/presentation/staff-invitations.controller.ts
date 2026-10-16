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
import { ConfigService } from '@nestjs/config';
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
import {
  PublicWebProtocol,
  resolvePublicWebProtocol,
  safeLinkHost,
} from '../../../shared/tenancy/public-link';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

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
  private readonly protocol: PublicWebProtocol;

  constructor(
    private readonly createInvitation: CreateInvitationUseCase,
    private readonly listInvitations: ListInvitationsUseCase,
    private readonly revokeInvitation: RevokeInvitationUseCase,
    private readonly resendInvitation: ResendInvitationUseCase,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  /**
   * Origen de la web de la clínica para el enlace del email: el host con el
   * que llegó esta petición (TenantContextInterceptor ya lo cruzó con el JWT),
   * validado ENTERO antes de tocar nada (ver safeLinkHost).
   */
  private linkBase(req: AuthenticatedRequest): string {
    const host = safeLinkHost(req.tenantHost?.host);
    if (!host) {
      throw new BadRequestException('Host inválido');
    }
    return `${this.protocol}://${host}`;
  }

  private toCreatedDto(result: CreateInvitationResult): CreatedInvitationDto {
    const { invitation, token, emailDelivery } = result;
    return {
      ...invitation,
      status: invitationStatus(invitation, new Date()),
      token,
      emailDelivery,
    };
  }

  @Post()
  // Cada una manda un email: límite por clínica + usuario (DX-088, B1).
  @RateLimit('invitation-email')
  @ApiOperation({
    summary:
      'Invita a una persona: crea la invitación y encola el email con el enlace (se envía en segundo plano)',
  })
  @ApiCreatedResponse({ type: CreatedInvitationDto })
  async create(
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedInvitationDto> {
    const linkBase = this.linkBase(req);
    const result = await this.createInvitation.execute({
      ...dto,
      invitedById: req.user.sub,
      linkBase,
    });
    return this.toCreatedDto(result);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RateLimit('invitation-email')
  @ApiOperation({
    summary:
      'Reenvía una invitación pendiente: token nuevo (el anterior deja de servir), 7 días más y un email nuevo',
  })
  @ApiOkResponse({ type: CreatedInvitationDto })
  @ApiNotFoundResponse({
    description: 'No hay una invitación pendiente con ese id en esta clínica',
  })
  async resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedInvitationDto> {
    const linkBase = this.linkBase(req);
    const result = await this.resendInvitation.execute({ id, linkBase });
    return this.toCreatedDto(result);
  }

  @Get()
  @ApiOkResponse({ type: [InvitationDto] })
  list(): Promise<InvitationDto[]> {
    return this.listInvitations.execute();
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.revokeInvitation.execute(id);
  }
}
