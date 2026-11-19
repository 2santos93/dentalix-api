import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { CLINIC_SETTINGS_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  MESSAGE_CHANNELS,
  MESSAGE_KEYS,
  MESSAGE_LANGUAGES,
} from '../domain/message-catalog';
import {
  ListMessageTemplatesUseCase,
  MESSAGE_TEMPLATE_LANGUAGE_MESSAGE,
  MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE,
  MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE,
  MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE,
  PreviewMessageTemplateUseCase,
  ResetMessageTemplateUseCase,
  SaveMessageTemplateUseCase,
  SendMessageTemplateTestUseCase,
  type MessagePreview,
  type MessageTemplatesView,
  type MessageTemplateView,
  type MessageTestResult,
} from '../application/message-templates.use-cases';
import {
  MessagePreviewDto,
  MessageTemplateDto,
  MessageTemplatesDto,
  MessageTemplateTestDto,
  MessageTemplateTextDto,
  MessageTestResultDto,
} from './dto/message-templates.dto';

export const MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver y cambiar los textos de los mensajes.';

const INVALID_DESCRIPTION =
  'MESSAGE_TEMPLATE_INVALID con `field` (`subject` | `body`) y el motivo: «La variable {x} no existe.», «{x} no se puede usar en el recordatorio.», «{importe} no se puede usar en …: los mensajes al paciente no llevan importes ni datos clínicos.», «La confirmación por WhatsApp tiene que llevar {enlace}.», topes, llaves o corchetes mal cerrados, enlaces o HTML. Sin `code`: «' +
  MESSAGE_TEMPLATE_LANGUAGE_MESSAGE +
  '».';

/** Los tres parámetros de la ruta (texto: los valida el caso de uso). */
function ApiMessagePath(): MethodDecorator {
  return (target, property, descriptor) => {
    ApiParam({ name: 'key', enum: MESSAGE_KEYS })(target, property, descriptor);
    ApiParam({ name: 'channel', enum: MESSAGE_CHANNELS })(
      target,
      property,
      descriptor,
    );
    ApiParam({ name: 'language', enum: MESSAGE_LANGUAGES })(
      target,
      property,
      descriptor,
    );
  };
}

/**
 * Ajustes › Mensajes (DX-565): los textos de los mensajes al paciente que la
 * clínica puede reescribir. Solo ADMIN; todo cambio, auditado.
 */
@ApiTags('clinic')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE)
@Controller('message-templates')
export class MessageTemplatesController {
  constructor(
    private readonly list: ListMessageTemplatesUseCase,
    private readonly save: SaveMessageTemplateUseCase,
    private readonly reset: ResetMessageTemplateUseCase,
    private readonly preview: PreviewMessageTemplateUseCase,
    private readonly sendTest: SendMessageTemplateTestUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private ctx(req: AuditableRequest) {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  @Get()
  @ApiOperation({
    summary:
      'Mensajes al paciente editables: canales, variables, textos por defecto y los de la clínica (DX-565)',
  })
  @ApiOkResponse({ type: MessageTemplatesDto })
  @ApiForbiddenResponse({ description: MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE })
  index(): Promise<MessageTemplatesView> {
    return this.list.execute();
  }

  @Put(':key/:channel/:language')
  @ApiMessagePath()
  @ApiOperation({
    summary: 'Guarda el texto de un mensaje en un idioma (DX-565)',
    description:
      'Crea o cambia la fila y lo audita en la misma transacción (CLINIC_SETTINGS, MESSAGE_TEMPLATE_UPDATED: CREATE o UPDATE con el asunto antes/después y del cuerpo su longitud y huella; el cuerpo, oculto). Sin cambios, no hay evento. Afecta a los envíos siguientes, nunca a los ya encolados.',
  })
  @ApiOkResponse({ type: MessageTemplateDto })
  @ApiBadRequestResponse({ description: INVALID_DESCRIPTION })
  @ApiNotFoundResponse({ description: MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE })
  @ApiForbiddenResponse({ description: MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE })
  update(
    @Param('key') key: string,
    @Param('channel') channel: string,
    @Param('language') language: string,
    @Body() dto: MessageTemplateTextDto,
    @Req() req: AuditableRequest,
  ): Promise<MessageTemplateView> {
    return this.save.execute(
      { key, channel, language },
      { subject: dto.subject, body: dto.body },
      this.ctx(req),
    );
  }

  @Delete(':key/:channel/:language')
  @ApiMessagePath()
  @ApiOperation({
    summary:
      'Restablece el texto por defecto de un mensaje en un idioma (DX-565)',
    description:
      'Borra el texto guardado y lo audita (CLINIC_SETTINGS, MESSAGE_TEMPLATE_RESET, DELETE con el antes). Sin texto guardado no hace nada. Vale también para un idioma que la clínica ya retiró.',
  })
  @ApiOkResponse({ type: MessageTemplateDto })
  @ApiBadRequestResponse({ description: MESSAGE_TEMPLATE_LANGUAGE_MESSAGE })
  @ApiNotFoundResponse({ description: MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE })
  @ApiForbiddenResponse({ description: MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE })
  remove(
    @Param('key') key: string,
    @Param('channel') channel: string,
    @Param('language') language: string,
    @Req() req: AuditableRequest,
  ): Promise<MessageTemplateView> {
    return this.reset.execute({ key, channel, language }, this.ctx(req));
  }

  @Post(':key/:channel/:language/preview')
  @HttpCode(200)
  @ApiMessagePath()
  @ApiOperation({
    summary: 'Vista previa de un borrador con datos de ejemplo (DX-565)',
    description:
      'No guarda ni envía nada. Email: asunto, HTML y texto con la marca de la clínica. WhatsApp: el texto prellenado.',
  })
  @ApiOkResponse({ type: MessagePreviewDto })
  @ApiBadRequestResponse({ description: INVALID_DESCRIPTION })
  @ApiNotFoundResponse({ description: MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE })
  @ApiForbiddenResponse({ description: MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE })
  render(
    @Param('key') key: string,
    @Param('channel') channel: string,
    @Param('language') language: string,
    @Body() dto: MessageTemplateTextDto,
  ): Promise<MessagePreview> {
    return this.preview.execute(
      { key, channel, language },
      { subject: dto.subject, body: dto.body },
    );
  }

  @Post(':key/:channel/:language/test')
  @HttpCode(200)
  @ApiMessagePath()
  @ApiOperation({
    summary:
      'Envía a tu correo una prueba del email con datos de ejemplo (DX-565)',
    description:
      'El borrador (o, sin `body`, lo guardado o el texto por defecto), con «[Prueba]» en el asunto y sin enlace de baja, solo a tu correo confirmado. Una cada 5 minutos por persona; gasta del tope diario de la clínica. Queda en la auditoría (VIEW de CLINIC_SETTINGS, MESSAGE_TEMPLATE_TEST_SENT).',
  })
  @ApiOkResponse({ type: MessageTestResultDto })
  @ApiBadRequestResponse({
    description: `${INVALID_DESCRIPTION} WhatsApp: «${MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE}»`,
  })
  @ApiConflictResponse({
    description: `EMAIL_NOT_VERIFIED: «${MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE}»`,
  })
  @ApiTooManyRequestsResponse({
    description:
      'Ya pediste una prueba hace menos de 5 minutos (o se alcanzó el tope de correos); `retryAfterSeconds` dice cuánto esperar.',
  })
  @ApiNotFoundResponse({ description: MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE })
  @ApiForbiddenResponse({ description: MESSAGE_TEMPLATES_FORBIDDEN_MESSAGE })
  test(
    @Param('key') key: string,
    @Param('channel') channel: string,
    @Param('language') language: string,
    @Body() dto: MessageTemplateTestDto,
    @Req() req: AuditableRequest,
  ): Promise<MessageTestResult> {
    return this.sendTest.execute(
      { key, channel, language },
      { subject: dto?.subject, body: dto?.body },
      this.ctx(req),
    );
  }
}
