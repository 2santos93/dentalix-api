import {
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
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateInvitationUseCase } from '../application/use-cases/create-invitation.use-case';
import { ListInvitationsUseCase } from '../application/use-cases/list-invitations.use-case';
import { RevokeInvitationUseCase } from '../application/use-cases/revoke-invitation.use-case';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreatedInvitationDto, InvitationDto } from './dto/invitation.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { STAFF_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { invitationStatus } from '../application/invitation-token';

interface AuthenticatedRequest {
  user: JwtPayload;
}

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
  ) {}

  @Post()
  @ApiCreatedResponse({ type: CreatedInvitationDto })
  async create(
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedInvitationDto> {
    const { invitation, token } = await this.createInvitation.execute({
      ...dto,
      invitedById: req.user.sub,
    });
    return {
      ...invitation,
      status: invitationStatus(invitation, new Date()),
      token,
    };
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
