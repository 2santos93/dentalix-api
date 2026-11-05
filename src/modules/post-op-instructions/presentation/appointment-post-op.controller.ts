import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
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
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../shared/validation/idempotency-key';
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
  @ApiBadRequestResponse({
    description:
      'La plantilla está inactiva, el host de la petición no sirve para armar el enlace (EMAIL y WHATSAPP_LINK), o la Idempotency-Key no es un UUID',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin email ni responsable que reciba avisos, sin un teléfono que sirva para WhatsApp, o el paciente dio de baja los envíos; o la cita está cancelada, fue un no-show o es de un día que aún no llega (DX-250); o la Idempotency-Key ya se usó con otra plantilla u otro canal (`code: IDEMPOTENCY_KEY_REUSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Tope de emails de la clínica o del destinatario',
  })
  @ApiConflictResponse({
    description:
      'Repetición (misma Idempotency-Key) de un EMAIL que aún se está registrando (`code: POSTOP_DELIVERY_IN_PROGRESS`): vuelve a consultar en unos segundos.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'DX-250: UUID generado una vez por clic y reutilizado en los reintentos. Repetir la petición con la misma clave en la misma cita devuelve la entrega ya registrada (sin `publicUrl` ni `whatsapp`: el token solo sale en la primera respuesta) en vez de crear otra, y no vuelve a encolar el email. La repetición responde igual 201 (no 200). Con otra plantilla u otro canal: 422 `IDEMPOTENCY_KEY_REUSED`.',
  })
  async create(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() dto: DeliverPostOpDto,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PostOpDeliveryCreatedDto> {
    if (idempotencyKey !== undefined && !isUUID(idempotencyKey)) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    // Como el enlace de confirmación (DX-005): el host entero se valida
    // antes de registrar nada; uno manipulado no arma un enlace hacia otro
    // sitio. Solo lo usan EMAIL y WHATSAPP_LINK (el caso de uso da 400).
    const host = safeLinkHost(req.tenantHost?.host);
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.deliver.execute(
      appointmentId,
      {
        templateId: dto.templateId,
        channel: dto.channel,
        idempotencyKey,
      },
      ctx,
      { protocol: this.protocol, host },
    );
  }
}
