import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetInvitationUseCase } from '../application/use-cases/get-invitation.use-case';
import { AcceptInvitationUseCase } from '../application/use-cases/accept-invitation.use-case';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { PublicInvitationDto } from './dto/public-invitation.dto';
import { AuthTokensDto } from '../../auth/presentation/dto/auth-tokens.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  DeliveredSession,
  SessionCookieService,
} from '../../auth/presentation/session-cookie.service';

// PUBLIC endpoints — no JwtAuthGuard/RolesGuard. Whoever is opening the
// invitation link doesn't have a session yet (that's the whole point of an
// invitation). Tenant identity comes solely from the resolved request host
// (see PublicTenantContextInterceptor + TenantHostMiddleware), same as
// public-branding.controller.ts; there is no JWT to cross-check.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP: frena la enumeración de tokens. Ver y aceptar usan la misma
// política, pero cada ruta cuenta en su propio balde.
@RateLimit('invitation')
@Controller('public/invitations')
export class PublicInvitationsController {
  constructor(
    private readonly getInvitation: GetInvitationUseCase,
    private readonly acceptInvitation: AcceptInvitationUseCase,
    private readonly cookie: SessionCookieService,
  ) {}

  @Get(':token')
  @ApiOkResponse({ type: PublicInvitationDto })
  getByToken(@Param('token') token: string): Promise<PublicInvitationDto> {
    // GetInvitationUseCase never throws — invalid/expired/used/revoked/
    // unknown tokens all come back as `{ status }` data, always 200.
    return this.getInvitation.execute(token);
  }

  // Aceptar abre sesión: en modo cookie el refresh llega en la cookie de
  // sesión del host de la clínica (DX-062).
  @Post(':token/accept')
  @ApiCreatedResponse({ type: AuthTokensDto })
  async accept(
    @Req() req: TenantHostRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<DeliveredSession> {
    const pair = await this.acceptInvitation.execute({
      token,
      password: dto.password,
    });
    return this.cookie.deliver(res, pair, this.cookie.wantsCookie(req));
  }
}
