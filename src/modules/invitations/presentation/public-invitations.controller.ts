import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetInvitationUseCase } from '../application/use-cases/get-invitation.use-case';
import { AcceptInvitationUseCase } from '../application/use-cases/accept-invitation.use-case';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { PublicInvitationDto } from './dto/public-invitation.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';

// PUBLIC endpoints — no JwtAuthGuard/RolesGuard. Whoever is opening the
// invitation link doesn't have a session yet (that's the whole point of an
// invitation). Tenant identity comes solely from the resolved request host
// (see PublicTenantContextInterceptor + TenantHostMiddleware), same as
// public-branding.controller.ts; there is no JWT to cross-check.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
@Controller('public/invitations')
export class PublicInvitationsController {
  constructor(
    private readonly getInvitation: GetInvitationUseCase,
    private readonly acceptInvitation: AcceptInvitationUseCase,
  ) {}

  @Get(':token')
  @ApiOkResponse({ type: PublicInvitationDto })
  getByToken(@Param('token') token: string): Promise<PublicInvitationDto> {
    // GetInvitationUseCase never throws — invalid/expired/used/revoked/
    // unknown tokens all come back as `{ status }` data, always 200.
    return this.getInvitation.execute(token);
  }

  @Post(':token/accept')
  @ApiCreatedResponse({ type: AuthTokensDto })
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<AuthTokensDto> {
    return this.acceptInvitation.execute({ token, password: dto.password });
  }
}
