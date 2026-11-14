import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { GetWorkQueuesSummaryUseCase } from '../application/work-queues-summary.use-case';
import type { WorkQueuesSummary } from '../domain/work-queues';
import {
  WorkQueuesSummaryDto,
  WorkQueuesSummaryQueryDto,
} from './dto/work-queues.dto';

interface AuthenticatedRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

/**
 * «Mi día» (DX-503): los recuentos de las listas de trabajo del rol. Abierto a
 * los cuatro roles (APPOINTMENT_ROLES: todos tienen al menos una lista); qué
 * listas entran lo decide `WORK_QUEUE_ROLES`, que nunca amplía el `@Roles` de
 * ninguna lista. Solo números: sin pacientes, sin teléfonos, sin @Audit (mismo
 * criterio que GET /closing-queue/count).
 */
@ApiTags('work-queues')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('work-queues')
export class WorkQueuesController {
  constructor(private readonly summary: GetWorkQueuesSummaryUseCase) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Recuentos de las listas de trabajo del rol («Mi día»)',
    description:
      'Cada número es el de su lista (closing-queue/count, submissions/summary, pending-follow-up/count, unscheduled/count, waitlist, recall/due/count, receivables/aging/summary, inventory lowStockOnly) con sus filtros por defecto, en la sede activa. ' +
      'ADMIN: todas. DENTIST: pendiente de cerrar (lo suyo) y anamnesis. RECEPTION: pendiente de cerrar (desenlace), presupuestos por seguir, aceptados sin agendar, lista de espera, recall y cartera. ASSISTANT: anamnesis y bajo stock. ' +
      'Una lista que falla sale con `status: ERROR` y `count: null`; las demás llegan igual.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede activa; sin ella, las sedes permitidas al usuario (vista consolidada)',
  })
  @ApiOkResponse({ type: WorkQueuesSummaryDto })
  @ApiBadRequestResponse({ description: 'Una clave de lista desconocida' })
  get(
    @Query() query: WorkQueuesSummaryQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<WorkQueuesSummary> {
    return this.summary.execute(
      { userId: req.user.sub, role: req.user.role },
      query.keys,
    );
  }
}
