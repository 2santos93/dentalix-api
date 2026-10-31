import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiForbiddenResponse,
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
  CLINICAL_ROLES,
  SIGNATURE_REQUEST_ROLES,
  TREATMENT_PLAN_DECISION_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  CreateSignatureRequestUseCase,
  GetSignatureRequestOptionsUseCase,
  ListPatientSignatureRequestsUseCase,
  RevokeSignatureRequestUseCase,
  type SignatureActor,
} from '../application/use-cases/signature-requests.use-cases';
import {
  CreateSignatureRequestDto,
  SignatureRequestCreatedDto,
  SignatureRequestDto,
  SignatureRequestOptionsDto,
} from './dto/signature-request.dto';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

function actorOf(req: AuthenticatedRequest): SignatureActor {
  return {
    userId: req.user.sub,
    clinical:
      isTenantPayload(req.user) && CLINICAL_ROLES.includes(req.user.role),
    decidesPlans:
      isTenantPayload(req.user) &&
      TREATMENT_PLAN_DECISION_ROLES.includes(req.user.role),
  };
}

// Firma a distancia desde la ficha (DX-243). Los cuatro roles: recepción y
// los clínicos envían. Ni la lista ni el modal llevan el texto del documento
// (solo el título); el token solo viaja en el email.
@ApiTags('signature-requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...SIGNATURE_REQUEST_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiNotFoundResponse({ description: 'Paciente no encontrado en esta clínica' })
@Controller('patients/:patientId/signature-requests')
export class PatientSignatureRequestsController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly getOptions: GetSignatureRequestOptionsUseCase,
    private readonly createRequest: CreateSignatureRequestUseCase,
    private readonly listRequests: ListPatientSignatureRequestsUseCase,
    private readonly revokeRequest: RevokeSignatureRequestUseCase,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  // Declarada antes que `:id`: Express casa las rutas en orden.
  @Get('options')
  @ApiOperation({
    summary: 'Lo que necesita el modal «Enviar a firmar»',
    description:
      'Plantillas activas (título y versión), profesionales que pueden firmar y a quién iría el enlace (enmascarado) o por qué no se puede enviar.',
  })
  @ApiOkResponse({ type: SignatureRequestOptionsDto })
  options(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SignatureRequestOptionsDto> {
    return this.getOptions.execute(patientId, actorOf(req));
  }

  @Get()
  @ApiOperation({
    summary:
      'Solicitudes de firma a distancia del paciente (estado y evidencias)',
  })
  @ApiOkResponse({ type: [SignatureRequestDto] })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<SignatureRequestDto[]> {
    return this.listRequests.execute(patientId);
  }

  // Ni la URL ni el token ni el destinatario van a la auditoría.
  @Audit({
    action: 'SEND',
    resource: 'SIGNATURE_REQUEST',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason: 'SIGNATURE_REQUEST_SENT',
  })
  @Post()
  @ApiOperation({
    summary:
      'Enviar un consentimiento a firmar o un presupuesto a aceptar a distancia (email)',
    description:
      'Congela el texto (plantilla, paciente, plan, profesional) y envía por email un enlace de un solo uso que caduca a las 72 h; el documento solo se ve tras un código de 6 dígitos. Un menor (mayoría de la clínica) firma por medio de su responsable. Anula la solicitud anterior del mismo paciente y plantilla aún sin firmar. BUDGET (DX-415): solo odontólogo o ADMIN; congela la foto del presupuesto de un plan «Presentado» y su hash, y anula el enlace anterior del mismo plan; si el plan cambia después, el enlace deja de servir.',
  })
  @ApiCreatedResponse({ type: SignatureRequestCreatedDto })
  @ApiBadRequestResponse({
    description:
      'BUDGET sin plan o sin ítems, sin plantilla, plantilla desactivada, profesional no válido o host no válido',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin email, menor sin responsable o paciente dado de baja de los envíos',
  })
  @ApiForbiddenResponse({
    description:
      'BUDGET enviado por un rol que no decide el plan (asistente o recepción), o desde una sede no permitida',
  })
  @ApiConflictResponse({
    description:
      'La sede no tiene formato regional, o BUDGET de un plan que no está «Presentado» (o ya aceptado)',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateSignatureRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SignatureRequestCreatedDto> {
    return this.createRequest.execute(
      patientId,
      {
        type: dto.type,
        channel: dto.channel,
        templateId: dto.templateId,
        treatmentPlanId: dto.treatmentPlanId,
        professionalId: dto.professionalId,
      },
      actorOf(req),
      { protocol: this.protocol, host: safeLinkHost(req.tenantHost?.host) },
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'SIGNATURE_REQUEST',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: 'SIGNATURE_REQUEST_REVOKED',
  })
  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anular un enlace sin firmar',
    description:
      'Desde ese momento el enlace responde «Enlace no válido». Cancela el email si aún no salió.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SignatureRequestDto })
  @ApiForbiddenResponse({ description: 'Enviada desde una sede no permitida' })
  @ApiConflictResponse({ description: 'Ya está firmada o anulada' })
  revoke(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SignatureRequestDto> {
    return this.revokeRequest.execute(patientId, id, req.user.sub);
  }
}
