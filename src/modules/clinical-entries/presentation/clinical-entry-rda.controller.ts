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
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { GetRdaReadinessUseCase } from '../application/use-cases/get-rda-readiness.use-case';
import type { RdaReadiness } from '../domain/rda-readiness';
import { RdaReadinessDto } from './dto/rda-readiness.dto';

/**
 * DX-212: ¿está la atención lista para el Resumen Digital de Atención (Res.
 * 1888/2025)? Solo comprueba; nada sale de Dentalix. Roles clínicos, como la
 * historia (recepción no ve diagnósticos).
 */
@ApiTags('clinical-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('clinical-entries')
export class ClinicalEntryRdaController {
  constructor(private readonly readiness: GetRdaReadinessUseCase) {}

  @Audit({
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY',
    resourceId: { param: 'id' },
    patient: { lookup: 'clinicalEntry', param: 'id' },
    reason: 'RDA_READINESS',
  })
  @Get(':id/rda-readiness')
  @ApiOperation({
    summary: 'Datos del RDA que faltan en la atención de una evolución',
    description:
      'Comprueba documento del paciente, diagnóstico principal CIE-10, CUPS de los procedimientos realizados ese día (odontograma) y registro profesional del autor. La sede de la atención es la de la cita o, sin cita, la principal. El NIT de la clínica sale en `pending` hasta DX-019. Sede fuera de Colombia: `notApplicable: true`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RdaReadinessDto })
  @ApiNotFoundResponse({
    description: 'Evolución inexistente o de otra clínica.',
  })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<RdaReadiness> {
    return this.readiness.execute(id);
  }
}
