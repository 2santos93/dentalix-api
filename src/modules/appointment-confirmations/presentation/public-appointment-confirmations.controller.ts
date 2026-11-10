import {
  Body,
  Controller,
  Get,
  Header,
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
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { GetPublicConfirmationUseCase } from '../application/use-cases/get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from '../application/use-cases/respond-confirmation.use-case';
import { SetWantsEarlierFromLinkUseCase } from '../application/use-cases/set-wants-earlier-from-link.use-case';
import { GetConfirmationCalendarUseCase } from '../application/use-cases/get-confirmation-calendar.use-case';
import {
  PublicAppointmentConfirmationDto,
  PublicWantsEarlierDto,
  RespondAppointmentConfirmationDto,
} from './dto/appointment-confirmation.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { currentRequestId } from '../../../shared/observability/request-context';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';

// PÚBLICO — sin JwtAuthGuard: quien abre el enlace es el paciente. El tenant
// sale SOLO del host (PublicTenantContextInterceptor + TenantHostMiddleware),
// igual que public-branding e invitaciones; la RLS hace invisible un token de
// otra clínica (→ 404).
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
// Por IP: frena la enumeración de tokens. Ver y responder cuentan en baldes
// separados (uno por ruta).
@RateLimit('confirmation')
@Controller('public/appointment-confirmations')
export class PublicAppointmentConfirmationsController {
  constructor(
    private readonly getConfirmation: GetPublicConfirmationUseCase,
    private readonly respondConfirmation: RespondConfirmationUseCase,
    private readonly setWantsEarlier: SetWantsEarlierFromLinkUseCase,
    private readonly calendar: GetConfirmationCalendarUseCase,
  ) {}

  // DX-469: antes que `:token` a secas (otra ruta, sin ambigüedad). Solo lee.
  @Get(':token/calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="cita.ics"')
  @ApiProduces('text/calendar')
  @ApiOperation({
    summary: 'DX-469: la cita del enlace como evento de calendario (.ics)',
    description:
      'RFC 5545: inicio y fin en UTC (el instante de la sede), clínica y profesional en el título, la sede y su dirección; sin motivo ni tratamiento. UID estable por cita (reprogramar actualiza, no duplica); una cancelada lleva STATUS:CANCELLED; VALARM con la antelación de la sede (`calendarAlarmHours` de los ajustes de recordatorio, 24 por defecto, 0 sin alarma). Vale con el enlace pendiente o ya respondido mientras la cita no haya terminado; caducado, revocado o cita pasada, 410. Solo lee: no se audita.',
  })
  @ApiOkResponse({ schema: { type: 'string' }, description: 'text/calendar' })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  @ApiGoneResponse({ description: 'El enlace caducó o la cita ya pasó.' })
  calendarIcs(@Param('token') token: string): Promise<string> {
    return this.calendar.execute(token);
  }

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

  @Post(':token/wants-earlier')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'DX-437: el paciente pide (o quita) que le avisen si se libera un hueco antes',
    description:
      'Pone o quita «Adelantar si hay hueco» en la cita del enlace, con la franja (MORNING, AFTERNOON o ANY) y la marca de que lo pidió el paciente. Vale con el enlace pendiente o ya respondido; caducado o sin efecto, 410. La cita tiene que estar agendada o confirmada, en el futuro y en un día posterior a hoy en la sede (400 en español si no). Queda en la auditoría como UPDATE de APPOINTMENT, sin usuario, origen PUBLIC_LINK y `reason` CONFIRMATION_LINK_EARLIER_REQUESTED o CONFIRMATION_LINK_EARLIER_CLEARED. Mismo límite de peticiones por IP que el resto del enlace.',
  })
  @ApiOkResponse({ type: PublicAppointmentConfirmationDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  @ApiBadRequestResponse({
    description:
      'La cita ya no se puede adelantar (cancelada, atendida…), ya pasó o es hoy.',
  })
  @ApiGoneResponse({ description: 'El enlace caducó o la cita cambió.' })
  wantsEarlier(
    @Param('token') token: string,
    @Body() dto: PublicWantsEarlierDto,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicAppointmentConfirmationDto> {
    const userAgent = req.headers['user-agent'];
    return this.setWantsEarlier.execute(token, dto, {
      requestId: currentRequestId() ?? null,
      ip: req.ip ?? null,
      userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
    });
  }
}
