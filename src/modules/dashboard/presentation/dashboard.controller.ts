import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardDto } from './dto/dashboard.dto';
import {
  GetDoctorDashboardUseCase,
  GetDoctorDashboardResult,
} from '../application/use-cases/get-doctor-dashboard.use-case';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { DASHBOARD_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

// Vista de gestión (ingresos/pagos convertidos + bajo stock + próximas citas
// + # pacientes) -> @Roles(...DASHBOARD_ROLES) (OWNER/ADMIN, coherente con
// PAYMENT_ROLES que ya restringe el dato financiero que este endpoint agrega
// -- ver docs/plans/2026-07-24-payments-pivot.md).
@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...DASHBOARD_ROLES)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly getDoctorDashboard: GetDoctorDashboardUseCase) {}

  @Get()
  @ApiOkResponse({ type: DashboardDto })
  get(@Query() query: DashboardQueryDto): Promise<GetDoctorDashboardResult> {
    return this.getDoctorDashboard.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      currency: query.currency,
      upcomingLimit: query.upcomingLimit,
    });
  }
}
