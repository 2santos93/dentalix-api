import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { POSTOP_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  GetPatientPostOpDeliveryUseCase,
  ListPatientPostOpDeliveriesUseCase,
} from '../application/use-cases/post-op-deliveries.use-cases';
import {
  PostOpDeliveryDocumentDto,
  PostOpDeliverySummaryDto,
} from './dto/post-op-delivery.dto';

// Historial de indicaciones entregadas al paciente (DX-222), en su ficha. Los
// cuatro roles. Sin PATCH ni DELETE A PROPÓSITO: la entrega es inalterable.
@ApiTags('post-op-instructions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...POSTOP_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/post-op-deliveries')
export class PatientPostOpDeliveriesController {
  constructor(
    private readonly listDeliveries: ListPatientPostOpDeliveriesUseCase,
    private readonly getDelivery: GetPatientPostOpDeliveryUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Indicaciones entregadas, las más recientes primero',
  })
  @ApiOkResponse({ type: [PostOpDeliverySummaryDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PostOpDeliverySummaryDto[]> {
    return this.listDeliveries.execute(patientId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Get(':id')
  @ApiOperation({
    summary: 'Una entrega con su texto, para verla o reimprimirla',
  })
  @ApiOkResponse({ type: PostOpDeliveryDocumentDto })
  @ApiNotFoundResponse({
    description: 'Paciente o entrega no encontrados en esta clínica',
  })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PostOpDeliveryDocumentDto> {
    return this.getDelivery.execute(patientId, id);
  }
}
