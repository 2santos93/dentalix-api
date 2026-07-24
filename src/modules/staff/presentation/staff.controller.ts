import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ListStaffUseCase } from '../application/use-cases/list-staff.use-case';
import { CreateStaffUseCase } from '../application/use-cases/create-staff.use-case';
import { UpdateStaffUseCase } from '../application/use-cases/update-staff.use-case';
import { DeactivateStaffUseCase } from '../application/use-cases/deactivate-staff.use-case';
import { StaffMember } from '../domain/entities/staff-member.entity';
import { StaffMemberDto } from './dto/staff-member.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PATIENT_ROLES,
  STAFF_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { JwtPayload } from '../../../shared/crypto/token.service';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// GET /staff feeds the appointments provider selector — every role that can
// touch the agenda (or just needs to see who's on staff) can read it, so it
// reuses PATIENT_ROLES (all 5) rather than a bespoke set.
//
// POST/PATCH/DELETE (staff management) are narrower: RolesGuard reads
// @Roles metadata via getAllAndOverride([handler, class]) (see
// roles.guard.ts), so the per-method @Roles(...STAFF_WRITE_ROLES) below
// correctly overrides the class-level @Roles(...PATIENT_ROLES) for those
// three routes, while GET keeps the class-level PATIENT_ROLES.
@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('staff')
export class StaffController {
  constructor(
    private readonly listStaff: ListStaffUseCase,
    private readonly createStaff: CreateStaffUseCase,
    private readonly updateStaff: UpdateStaffUseCase,
    private readonly deactivateStaff: DeactivateStaffUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [StaffMemberDto] })
  list(): Promise<StaffMember[]> {
    return this.listStaff.execute();
  }

  @Post()
  @Roles(...STAFF_WRITE_ROLES)
  @ApiCreatedResponse({ type: StaffMemberDto })
  create(@Body() dto: CreateStaffDto): Promise<StaffMember> {
    return this.createStaff.execute(dto);
  }

  @Patch(':userId')
  @Roles(...STAFF_WRITE_ROLES)
  @ApiOkResponse({ type: StaffMemberDto })
  update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateStaffDto,
  ): Promise<StaffMember> {
    return this.updateStaff.execute({ userId, ...dto });
  }

  @Delete(':userId')
  @Roles(...STAFF_WRITE_ROLES)
  @HttpCode(204)
  async remove(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.deactivateStaff.execute({
      userId,
      requestingUserId: req.user.sub,
    });
  }
}
