import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { GetPublicConfirmationUseCase } from '../application/use-cases/get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from '../application/use-cases/respond-confirmation.use-case';
import {
  PublicAppointmentConfirmationDto,
  RespondAppointmentConfirmationDto,
} from './dto/appointment-confirmation.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { currentRequestId } from '../../../shared/observability/request-context';

// PÚBLICO — sin JwtAuthGuard: quien abre el enlace es el paciente. El tenant
// sale SOLO del host (PublicTenantContextInterceptor + TenantHostMiddleware),
// igual que public-branding e invitaciones; la RLS hace invisible un token de
// otra clínica (→ 404).
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP: frena la enumeración de tokens. Ver y responder cuentan en baldes
// separados (uno por ruta).
@RateLimit('confirmation')
@Controller('public/appointment-confirmations')
export class PublicAppointmentConfirmationsController {
  constructor(
    private readonly getConfirmation: GetPublicConfirmationUseCase,
    private readonly respondConfirmation: RespondConfirmationUseCase,
  ) {}

  // SOLO LECTURA: abrir el enlace no cambia nada (los previsualizadores de
  // WhatsApp lo abren solos). Responder exige el POST del segundo clic.
  @Get(':token')
  @ApiOkResponse({ type: PublicAppointmentConfirmationDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  get(
    @Param('token') token: string,
  ): Promise<PublicAppointmentConfirmationDto> {
    return this.getConfirmation.execute(token);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'El paciente confirma, cancela o pide que lo llamen',
    description:
      'DX-361: una respuesta registrada queda en la auditoría de la clínica de la cita como UPDATE de APPOINTMENT, sin usuario (el paciente), origen LINK y `reason` CONFIRMATION_LINK_CONFIRMED, CONFIRMATION_LINK_CANCELLED o CONFIRMATION_LINK_CALL_REQUESTED. Sin el token ni la URL; un enlace desconocido, caducado o ya usado no deja evento.',
  })
  @ApiOkResponse({ type: PublicAppointmentConfirmationDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  @ApiBadRequestResponse({
    description:
      'DX-291: cancelar con menos aviso que la política sin `acknowledgePolicy: true` (mensaje en español).',
  })
  @ApiConflictResponse({
    description:
      'El enlace ya se usó para responder, o (DX-291) la política vigente no es la que mostró la página.',
  })
  @ApiGoneResponse({
    description: 'El enlace caducó o la cita cambió desde que se envió.',
  })
  respond(
    @Param('token') token: string,
    @Body() dto: RespondAppointmentConfirmationDto,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicAppointmentConfirmationDto> {
    const userAgent = req.headers['user-agent'];
    return this.respondConfirmation.execute(
      token,
      dto.action,
      {
        acknowledgePolicy: dto.acknowledgePolicy,
        policyVersionId: dto.policyVersionId,
      },
      {
        requestId: currentRequestId() ?? null,
        ip: req.ip ?? null,
        userAgent:
          (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
      },
    );
  }
}
