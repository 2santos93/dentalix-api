import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ListStaffUseCase } from '../application/use-cases/list-staff.use-case';
import { StaffMember } from '../domain/entities/staff-member.entity';
import { StaffMemberDto } from './dto/staff-member.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

// GET /staff feeds the appointments provider selector — every role that can
// touch the agenda (or just needs to see who's on staff) can read it, so it
// reuses PATIENT_ROLES (all 5) rather than a bespoke set.
@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('staff')
export class StaffController {
  constructor(private readonly listStaff: ListStaffUseCase) {}

  @Get()
  @ApiOkResponse({ type: [StaffMemberDto] })
  list(): Promise<StaffMember[]> {
    return this.listStaff.execute();
  }
}
