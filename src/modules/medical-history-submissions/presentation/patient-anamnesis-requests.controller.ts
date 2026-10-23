import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type JwtPayload,
  isTenantPayload,
} from '../../../shared/crypto/token.service';
import {
  resolvePublicWebProtocol,
  safeLinkHost,
} from '../../../shared/tenancy/public-link';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  ANAMNESIS_REQUEST_ROLES,
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  CreateAnamnesisRequestUseCase,
  ListPatientAnamnesisRequestsUseCase,
} from '../application/use-cases/anamnesis-requests.use-cases';
import {
  AnamnesisRequestCreatedDto,
  AnamnesisSubmissionSummaryDto,
  CreateAnamnesisRequestDto,
} from './dto/anamnesis-requests.dto';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

// Anamnesis por enlace desde la ficha y la cita (DX-099). Los cuatro roles:
// recepción manda el enlace. La lista de la ficha no lleva respuestas, solo
// el estado (las respuestas se ven en la bandeja, CLINICAL_ROLES).
@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ANAMNESIS_REQUEST_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiNotFoundResponse({ description: 'Paciente no encontrado en esta clínica' })
@Controller('patients/:patientId/medical-history/requests')
export class PatientAnamnesisRequestsController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly createRequest: CreateAnamnesisRequestUseCase,
    private readonly listRequests: ListPatientAnamnesisRequestsUseCase,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  // Ni la URL ni el token van a la auditoría: solo el id del envío.
  @Audit({
    action: 'CREATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason: 'ANAMNESIS_LINK_CREATED',
  })
  @Post()
  @ApiOperation({
    summary: 'Crear el enlace de anamnesis para el paciente',
    description:
      'Un solo uso; caduca a los 7 días o al inicio de la cita. Anula el enlace anterior que aún esperaba respuesta. Devuelve la URL una única vez (se guarda solo el hash del token) y el mensaje para wa.me.',
  })
  @ApiCreatedResponse({ type: AnamnesisRequestCreatedDto })
  @ApiBadRequestResponse({
    description:
      'La cita es de otro paciente, o el host de la petición no sirve para armar el enlace',
  })
  @ApiConflictResponse({
    description:
      'El paciente no tiene la autorización de datos de salud y la clínica no ha publicado su política (no habría qué pedirle)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La cita ya empezó o no está agendada',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateAnamnesisRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnamnesisRequestCreatedDto> {
    return this.createRequest.execute(
      patientId,
      { appointmentId: dto.appointmentId },
      req.user.sub,
      { protocol: this.protocol, host: safeLinkHost(req.tenantHost?.host) },
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Anamnesis enviadas al paciente (estado, sin respuestas)',
    description:
      'El motivo de un rechazo (texto libre clínico) solo llega a los roles clínicos; a recepción, `rejectReason` = null.',
  })
  @ApiOkResponse({ type: [AnamnesisSubmissionSummaryDto] })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnamnesisSubmissionSummaryDto[]> {
    const clinical =
      isTenantPayload(req.user) && CLINICAL_ROLES.includes(req.user.role);
    return this.listRequests.execute(patientId, { clinical });
  }
}
