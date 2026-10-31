import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { PlanVisitsService } from '../application/plan-visits.service';
import {
  UnscheduledPlansCountDto,
  UnscheduledPlansCountQueryDto,
  UnscheduledPlansQueryDto,
  UpdatePlanVisitsDto,
  PlanVisitsDto,
  UnscheduledPlansPageDto,
} from './dto/plan-visits.dto';
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
)
@Controller('treatment-plans')
export class PlanVisitsController {
  constructor(private readonly visits: PlanVisitsService) {}
  @Get('unscheduled')
  @ApiOkResponse({ type: UnscheduledPlansPageDto })
  @Audit({ action: 'VIEW', resource: 'TREATMENT_PLAN' })
  list(@Query() input: UnscheduledPlansQueryDto) {
    return this.visits.unscheduled(input);
  }
  // Inicio (I1): solo el número, sin pacientes ni montos, así que sin @Audit
  // (mismo criterio que GET /closing-queue/count). Mismos filtros y alcance.
  @Get('unscheduled/count')
  @ApiOkResponse({ type: UnscheduledPlansCountDto })
  async count(
    @Query() input: UnscheduledPlansCountQueryDto,
  ): Promise<UnscheduledPlansCountDto> {
    const page = await this.visits.unscheduled({ ...input, limit: 1 });
    return { total: page.total };
  }
  @Get(':id/visits')
  @ApiOkResponse({ type: PlanVisitsDto })
  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.get(id);
  }
  @Patch(':id/visits')
  @ApiOkResponse({ type: PlanVisitsDto })
  @Roles(ClinicRole.ADMIN, ClinicRole.DENTIST)
  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'PLAN_VISITS',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdatePlanVisitsDto,
  ) {
    return this.visits.update(id, input.items, input.visitIntervals);
  }
}
