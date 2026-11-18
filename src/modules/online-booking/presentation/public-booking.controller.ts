import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  CreatePublicBookingUseCase,
  GetPublicBookingConfigUseCase,
  ListPublicSlotsUseCase,
  RequestBookingCodeUseCase,
  VerifyBookingCodeUseCase,
  type PublicRequestInfo,
} from '../application/use-cases/public-booking.use-cases';
import { ONLINE_BOOKING_MESSAGES } from '../domain/online-booking-errors';
import {
  BookingCodeSentDto,
  BookingSessionDto,
  CreatePublicBookingDto,
  PublicBookingConfigDto,
  PublicBookingResultDto,
  PublicSlotsDto,
  PublicSlotsQueryDto,
  RequestBookingCodeDto,
  VerifyBookingCodeDto,
} from './dto/online-booking.dto';

type PublicRequest = TenantHostRequest & { ip?: string };

const SESSION_HEADER = 'x-booking-session';

function infoOf(req: PublicRequest): PublicRequestInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null,
    requestId: currentRequestId() ?? null,
    host: req.tenantHost?.host,
  };
}

function sessionOf(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.length > 0 ? v : null;
}

const SessionHeader = ApiHeader({
  name: 'X-Booking-Session',
  required: false,
  description:
    'Sesión del paciente existente (POST …/verify) o de reintento tras un 409.',
});

const UNAVAILABLE = `«${ONLINE_BOOKING_MESSAGES.unavailable}»: reserva desactivada, host sin clínica o desconocido (la misma respuesta).`;

// PÚBLICO (DX-016) — sin JwtAuthGuard: quien reserva es el paciente. La
// clínica sale SOLO del host (PublicTenantContextInterceptor; ningún
// parámetro la elige) y la RLS hace el resto. Lecturas por IP
// (`online-booking`) y escrituras con su balde estricto por IP
// (`online-booking-write`), además del global. `no-store` y `no-referrer` en
// toda respuesta. Los pasos se auditan en el repositorio, en su transacción.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@Controller('public/booking')
export class PublicBookingController {
  constructor(
    private readonly getConfig: GetPublicBookingConfigUseCase,
    private readonly listSlots: ListPublicSlotsUseCase,
    private readonly requestCode: RequestBookingCodeUseCase,
    private readonly verifyCode: VerifyBookingCodeUseCase,
    private readonly createBooking: CreatePublicBookingUseCase,
  ) {}

  @Get()
  @RateLimit('online-booking')
  @ApiOperation({
    summary: 'Lo que ofrece la reserva online de la clínica del host',
    description:
      'Sedes, tipos de cita reservables, profesionales, modos, antelaciones y la política de datos vigente, más el `formToken` que acompaña a cada envío. Nada de la agenda.',
  })
  @ApiOkResponse({ type: PublicBookingConfigDto })
  @ApiNotFoundResponse({ description: UNAVAILABLE })
  config(): Promise<PublicBookingConfigDto> {
    return this.getConfig.execute();
  }

  @Get('slots')
  @RateLimit('online-booking')
  @SessionHeader
  @ApiOperation({
    summary: 'Huecos libres (solo instantes) de un tipo en una sede',
    description:
      'Dentro del horario de la sede y del profesional, sin festivos, bloqueos ni citas, con la antelación mínima y máxima. Hasta 14 días por consulta. Nunca nombres ni datos de otras citas.',
  })
  @ApiOkResponse({ type: PublicSlotsDto })
  @ApiBadRequestResponse({ description: 'Fecha o número de días inválidos' })
  @ApiNotFoundResponse({ description: UNAVAILABLE })
  slots(
    @Query() query: PublicSlotsQueryDto,
    @Headers(SESSION_HEADER) session: string | undefined,
  ): Promise<PublicSlotsDto> {
    return this.listSlots.execute({
      locationId: query.locationId,
      appointmentTypeId: query.appointmentTypeId,
      providerId: query.providerId ?? null,
      patientKind: query.patientKind,
      from: query.from,
      days: query.days ?? 7,
      sessionToken: sessionOf(session),
    });
  }

  @Post('verification')
  @HttpCode(200)
  @RateLimit('online-booking-write')
  @ApiOperation({
    summary: 'Pedir el código de un solo uso (paciente existente)',
    description:
      'Nombre, apellido, fecha de nacimiento y email. Si casan con UNA ficha, se envía el código a ese email (10 min, 5 intentos, 5 por hora). La respuesta es SIEMPRE la misma: no dice si la ficha existe.',
  })
  @ApiOkResponse({ type: BookingCodeSentDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o protección anti-bots',
  })
  @ApiNotFoundResponse({ description: UNAVAILABLE })
  code(
    @Body() dto: RequestBookingCodeDto,
    @Req() req: PublicRequest,
  ): Promise<BookingCodeSentDto> {
    return this.requestCode.execute(dto, infoOf(req));
  }

  @Post('verification/:id/verify')
  @HttpCode(200)
  @RateLimit('online-booking-write')
  @ApiOperation({
    summary: 'Verificar el código: abre una sesión de 30 minutos',
  })
  @ApiOkResponse({ type: BookingSessionDto })
  @ApiBadRequestResponse({
    description: `«${ONLINE_BOOKING_MESSAGES.codeInvalid}» (incorrecto, caducado, usado o bloqueado: la misma respuesta)`,
  })
  @ApiNotFoundResponse({ description: UNAVAILABLE })
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyBookingCodeDto,
    @Req() req: PublicRequest,
  ): Promise<BookingSessionDto> {
    return this.verifyCode.execute(id, dto.code, infoOf(req));
  }

  @Post()
  @RateLimit('online-booking-write')
  @SessionHeader
  @ApiOperation({
    summary: 'Reservar (directa) o pedir (solicitud) un hueco',
    description:
      'Paciente nuevo: `newPatient` con su consentimiento. Existente: cabecera X-Booking-Session. El inicio tiene que ser uno de los huecos ofrecidos; dos reservas del mismo hueco a la vez: solo una lo consigue y la otra recibe 409 `ONLINE_SLOT_TAKEN` (con `sessionToken` si ya se creó la ficha nueva).',
  })
  @ApiCreatedResponse({ type: PublicBookingResultDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o protección anti-bots',
  })
  @ApiUnauthorizedResponse({
    description: ONLINE_BOOKING_MESSAGES.sessionInvalid,
  })
  @ApiNotFoundResponse({ description: UNAVAILABLE })
  @ApiConflictResponse({
    description:
      '`ONLINE_SLOT_TAKEN` (otro lo ganó), `ONLINE_SLOT_GONE` (ya no se ofrece), `ONLINE_PATIENT_BUSY` o `PRIVACY_POLICY_OUTDATED`.',
  })
  book(
    @Body() dto: CreatePublicBookingDto,
    @Headers(SESSION_HEADER) session: string | undefined,
    @Req() req: PublicRequest,
  ): Promise<PublicBookingResultDto> {
    return this.createBooking.execute(
      {
        locationId: dto.locationId,
        appointmentTypeId: dto.appointmentTypeId,
        providerId: dto.providerId ?? null,
        start: dto.start,
        newPatient: dto.newPatient ?? null,
        sessionToken: sessionOf(session),
        website: dto.website,
        formToken: dto.formToken,
        challengeToken: dto.challengeToken ?? null,
      },
      infoOf(req),
    );
  }
}
