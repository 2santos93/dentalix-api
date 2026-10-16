import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TREATMENT_PLAN_FOLLOW_UP_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { ListPendingFollowUpUseCase } from '../application/use-cases/list-pending-follow-up.use-case';
import {
  PendingFollowUpPageDto,
  PendingFollowUpQueryDto,
} from './dto/pending-follow-up.dto';

// Presupuestos por seguir (DX-040). Controlador propio y registrado ANTES que
// TreatmentPlansController: si no, `GET /treatment-plans/:id` capturaría
// `pending-follow-up` como si fuera un id (auth-matrix.spec lo vigila).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...TREATMENT_PLAN_FOLLOW_UP_ROLES)
@Controller('treatment-plans')
export class PlanFollowUpController {
  constructor(
    private readonly listPendingFollowUp: ListPendingFollowUpUseCase,
  ) {}

  @Get('pending-follow-up')
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Solo los presentados en esta sede; sin ella, toda la clínica (vista consolidada)',
  })
  @ApiOkResponse({
    type: PendingFollowUpPageDto,
    description:
      'Planes PRESENTED hace más de `olderThanDays` días (7 por defecto) cuyo paciente no tiene cita futura agendada o confirmada, de los más antiguos a los más nuevos, con monto y moneda del plan',
  })
  list(
    @Query() query: PendingFollowUpQueryDto,
  ): Promise<PendingFollowUpPageDto> {
    return this.listPendingFollowUp.execute({
      olderThanDays: query.olderThanDays,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
