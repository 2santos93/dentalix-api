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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { currentRequestId } from '../../../shared/observability/request-context';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  PublicCheckInUseCases,
  type PublicArrivalView,
  type PublicCheckInQrView,
} from '../application/public-check-in.use-cases';
import {
  CHECK_IN_NO_MATCH_CODE,
  CHECK_IN_QR_INACTIVE_CODE,
} from '../domain/check-in-identity';
import {
  PublicArrivalViewDto,
  PublicCheckInIdentifyDto,
  PublicCheckInQrViewDto,
} from './dto/check-in.dto';

type PublicRequest = TenantHostRequest & { ip?: string };

function requestMeta(req: PublicRequest): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

// PÚBLICO (DX-265) — sin JwtAuthGuard: quien llega es el paciente. El tenant
// sale SOLO del host (PublicTenantContextInterceptor); la RLS hace invisible
// lo de otra clínica (→ el mismo 404 que lo inventado). `no-store` y
// `noindex`. Nunca datos clínicos: nombre de pila, hora y sede como mucho.

/** «Ya llegué» desde el enlace de la cita (DX-005), en su propia ruta. */
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
// El mismo límite por IP que el resto del enlace (un balde por ruta).
@RateLimit('confirmation')
@Controller('public/appointment-confirmations')
export class PublicAppointmentArrivalController {
  constructor(private readonly checkIn: PublicCheckInUseCases) {}

  @Get(':token/arrival')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'DX-265: ¿puede el paciente marcar «Ya llegué» con este enlace?',
    description:
      'Solo lee. Vale el día de la cita, aunque el enlace de confirmación ya haya caducado al empezar la cita; un enlace sustituido (recepción emitió otro) o de una sede que no lo ofrece da UNAVAILABLE.',
  })
  @ApiOkResponse({ type: PublicArrivalViewDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  view(@Param('token') token: string): Promise<PublicArrivalView> {
    return this.checkIn.linkView(token);
  }

  @Post(':token/arrival')
  @HttpCode(200)
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'DX-265: el paciente marca «Ya llegué» desde el enlace de su cita',
    description:
      'Dentro de la ventana de la sede (por defecto de 30 min antes a 30 después del inicio, el día de la cita en la zona de la sede) y con la cita agendada o confirmada: la cita pasa a «Llegó» por el MISMO camino que recepción (turno del día incluido). Idempotente: ya llegado devuelve ARRIVED sin otro evento. Auditoría: UPDATE de APPOINTMENT sin usuario, origen PATIENT_LINK, `reason` PATIENT_SELF_CHECK_IN.',
  })
  @ApiOkResponse({ type: PublicArrivalViewDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  @ApiConflictResponse({
    description:
      'Fuera de la ventana o la cita no lo admite (mensaje en español); no cambia nada.',
  })
  arrive(
    @Param('token') token: string,
    @Req() req: PublicRequest,
  ): Promise<PublicArrivalView> {
    return this.checkIn.linkArrive(token, requestMeta(req));
  }
}

/** El QR de la sede: identificación con documento y fecha de nacimiento. */
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('check-in')
@Controller('public/check-in')
export class PublicCheckInController {
  constructor(private readonly checkIn: PublicCheckInUseCases) {}

  @Get(':token')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'DX-265: la sede del QR de llegada (marca de la clínica y nombre)',
  })
  @ApiOkResponse({ type: PublicCheckInQrViewDto })
  @ApiNotFoundResponse({
    description: `\`${CHECK_IN_QR_INACTIVE_CODE}\`: QR malformado, desconocido, retirado, de otra clínica o de una sede retirada (la misma respuesta).`,
  })
  view(@Param('token') token: string): Promise<PublicCheckInQrView> {
    return this.checkIn.qrView(token);
  }

  @Post(':token')
  @HttpCode(200)
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary:
      'DX-265: el paciente se identifica con el QR de la sede y marca su llegada',
    description:
      'Busca SOLO las citas de hoy (zona de la sede) en la sede del QR cuyo paciente tenga ese documento y esa fecha de nacimiento; nunca lista nombres. Con una dentro de la ventana, la cita pasa a «Llegó» (MISMO camino que recepción; origen SEDE_QR en la auditoría). Fuera de la ventana devuelve TOO_EARLY o TOO_LATE sin cambiar nada; ya llegado, ARRIVED. Toda respuesta tarda al menos 400 ms. Tras 5 fallos desde la misma IP en la sede, 429 `CHECK_IN_LOCKED` con `retryAfterSeconds` durante 15 minutos (también si los datos no son de nadie).',
  })
  @ApiOkResponse({ type: PublicArrivalViewDto })
  @ApiBadRequestResponse({
    description: `\`${CHECK_IN_NO_MATCH_CODE}\`: la MISMA respuesta exista o no el paciente, tenga o no cita hoy en otra sede.`,
  })
  @ApiNotFoundResponse({ description: `\`${CHECK_IN_QR_INACTIVE_CODE}\`` })
  identify(
    @Param('token') token: string,
    @Body() dto: PublicCheckInIdentifyDto,
    @Req() req: PublicRequest,
  ): Promise<PublicArrivalView> {
    return this.checkIn.qrIdentify(
      token,
      { documentNumber: dto.documentNumber, birthDate: dto.birthDate },
      requestMeta(req),
    );
  }
}
