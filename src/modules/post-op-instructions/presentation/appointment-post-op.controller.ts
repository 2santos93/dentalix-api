import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
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
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { POSTOP_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  resolvePublicWebProtocol,
  safeLinkHost,
} from '../../../shared/tenancy/public-link';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  DeliverPostOpInstructionsUseCase,
  GetPostOpSuggestionsUseCase,
  POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE,
} from '../application/use-cases/post-op-deliveries.use-cases';
import {
  DeliverPostOpDto,
  PostOpDeliveryCreatedDto,
  PostOpSuggestionsDto,
} from './dto/post-op-delivery.dto';

type AuthenticatedRequest = TenantHostRequest & AuditableRequest;

// Indicaciones postoperatorias de una cita (DX-222): qué plantillas sugerir y
// entregarlas por impresión, email o enlace de WhatsApp. Los cuatro roles:
// recepción también las entrega en el mostrador. Sin PATCH ni DELETE A
// PROPÓSITO: una entrega registrada es inalterable.
@ApiTags('post-op-instructions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...POSTOP_ROLES)
@ApiParam({ name: 'appointmentId', format: 'uuid' })
@ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
@Controller('appointments/:appointmentId/post-op-instructions')
export class AppointmentPostOpController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly suggestions: GetPostOpSuggestionsUseCase,
    private readonly deliver: DeliverPostOpInstructionsUseCase,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  @Audit({
    action: 'VIEW',
    resource: 'POSTOP_DELIVERY',
    patient: { response: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Plantillas sugeridas para la cita, canales y entregas hechas',
  })
  @ApiOkResponse({ type: PostOpSuggestionsDto })
  get(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ): Promise<PostOpSuggestionsDto> {
    return this.suggestions.execute(appointmentId);
  }

  // Auditada en el caso de uso (CREATE POSTOP_DELIVERY con el canal como
  // `reason`): el decorador no sabe leer el id de `delivery` ni el canal.
  @Post('deliveries')
  @ApiOperation({
    summary: 'Entregar indicaciones: impresas, por email o por WhatsApp',
    description:
      'Registra la entrega con el texto ya renderizado (no cambia aunque se edite la plantilla). EMAIL y WHATSAPP_LINK crean un enlace público de 30 días.',
  })
  @ApiCreatedResponse({ type: PostOpDeliveryCreatedDto })
  @ApiBadRequestResponse({ description: 'La plantilla está inactiva' })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin email ni responsable que reciba avisos, sin teléfono con indicativo, o el paciente dio de baja los envíos',
  })
  @ApiTooManyRequestsResponse({
    description: 'Tope de emails de la clínica o del destinatario',
  })
  async create(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() dto: DeliverPostOpDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpDeliveryCreatedDto> {
    // Como el enlace de confirmación (DX-005): el host entero se valida antes
    // de registrar nada; uno manipulado no arma un enlace hacia otro sitio.
    if (!req.tenantHost?.host) {
      throw new NotFoundException(POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE);
    }
    const host = safeLinkHost(req.tenantHost.host);
    if (!host) throw new BadRequestException('Invalid host');
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.deliver.execute(
      appointmentId,
      { templateId: dto.templateId, channel: dto.channel },
      ctx,
      { protocol: this.protocol, host },
    );
  }
}
