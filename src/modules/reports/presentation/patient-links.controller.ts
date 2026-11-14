import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetPatientLinksUseCase,
  type PatientLinksReport,
} from '../application/use-cases/get-patient-links.use-case';
import {
  PatientLinksQueryDto,
  PatientLinksReportDto,
} from './dto/patient-links.dto';
import { REPORTS_FORBIDDEN_MESSAGE } from './locations-comparison.controller';

const SCOPE =
  'Por tipo de enlace y sede: los ENVIADOS en el período (fecha de envío en la zona de la sede del enlace, DX-097) y, de esos mismos, los abiertos, los completados y los caducados sin abrir, mirados ahora (`asOf`). ' +
  'Tasas = parte ÷ enviados, en % con 1 decimal; sin envíos, null. Mediana de horas del envío al completado. ' +
  'Anamnesis: abierta = la página avisó de la apertura o se envió; completada = enviada. Firma (consentimiento o presupuesto): abierta = pidió el código, lo verificó o firmó; completada = firmada. ' +
  'Confirmación de cita: completada = respondida (confirmar, cancelar o «llámenme»); no guarda la apertura, así que abiertos y caducados sin abrir van en null. ' +
  'Indicaciones postoperatorias (solo email y WhatsApp): abierta = primera apertura; no tienen paso de completar (null). ' +
  'Caducado sin abrir: pasó su caducidad sin abrirse ni completarse; un enlace anulado o reemplazado no cuenta. Sede: la del enlace; en la confirmación, la de la cita. ' +
  'Solo ADMIN; un miembro restringido (DX-089) solo ve sus sedes. Sin datos de pacientes.';

// «Enlaces del paciente» (DX-424). Agregados sin pacientes: sin auditoría,
// como «Comparar sedes».
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...REPORT_ROLES)
@RolesDeniedMessage(REPORTS_FORBIDDEN_MESSAGE)
@Controller('reports')
export class PatientLinksController {
  constructor(
    private readonly patientLinks: GetPatientLinksUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('patient-links')
  @ApiOperation({
    summary:
      'Enlaces del paciente: enviados, abiertos, completados y caducados sin abrir por tipo y sede',
    description: SCOPE,
  })
  @ApiOkResponse({ type: PatientLinksReportDto })
  @ApiBadRequestResponse({
    description: 'Período inválido o de más de 366 días',
  })
  @ApiForbiddenResponse({
    description: `${REPORTS_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`,
  })
  @ApiConflictResponse({
    description:
      'LOCATION_TIMEZONE_REQUIRED: una sede con enlaces no tiene zona horaria válida',
  })
  get(@Query() query: PatientLinksQueryDto): Promise<PatientLinksReport> {
    return this.patientLinks.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }
}
