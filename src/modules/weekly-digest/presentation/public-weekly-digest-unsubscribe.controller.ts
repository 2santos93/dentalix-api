import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import {
  ConfirmPublicWeeklyDigestUnsubscribeUseCase,
  GetPublicWeeklyDigestUnsubscribeUseCase,
  WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE,
  type PublicWeeklyDigestUnsubscribeView,
} from '../application/weekly-digest-unsubscribe.use-cases';
import { PublicWeeklyDigestUnsubscribeDto } from './dto/weekly-digest.dto';

interface PublicRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

// PÚBLICO — sin JwtAuthGuard: quien abre el enlace es el destinatario del
// resumen semanal, desde su email (DX-568, D7). Como la baja de los
// recordatorios (DX-128): el tenant sale SOLO del host y la RLS hace
// invisible un token de otra clínica (→ 404). Límite por IP de la
// confirmación (DX-131: frena la enumeración) y sin caché (SEC-064).
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('confirmation')
@Controller('public/weekly-digest-unsubscribe')
export class PublicWeeklyDigestUnsubscribeController {
  constructor(
    private readonly getUnsubscribe: GetPublicWeeklyDigestUnsubscribeUseCase,
    private readonly confirmUnsubscribe: ConfirmPublicWeeklyDigestUnsubscribeUseCase,
  ) {}

  // SOLO LECTURA: abrir el enlace no da de baja.
  @Get(':token')
  @ApiOperation({
    summary: 'Ver el enlace para dejar de recibir el resumen semanal (DX-568)',
  })
  @ApiOkResponse({ type: PublicWeeklyDigestUnsubscribeDto })
  @ApiNotFoundResponse({ description: WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE })
  get(
    @Param('token') token: string,
  ): Promise<PublicWeeklyDigestUnsubscribeView> {
    return this.getUnsubscribe.execute(token);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dejar de recibir el resumen semanal (idempotente, DX-568)',
    description:
      'Quita a la persona del enlace de los destinatarios, marca el enlace usado y lo audita (UPDATE de CLINIC_SETTINGS, WEEKLY_DIGEST_UNSUBSCRIBED, origen LINK, con esa persona como actor). Repetirlo responde lo mismo sin escribir.',
  })
  @ApiOkResponse({ type: PublicWeeklyDigestUnsubscribeDto })
  @ApiNotFoundResponse({ description: WEEKLY_DIGEST_LINK_NOT_FOUND_MESSAGE })
  confirm(
    @Param('token') token: string,
    @Req() req: PublicRequest,
  ): Promise<PublicWeeklyDigestUnsubscribeView> {
    const userAgent = req.headers['user-agent'];
    return this.confirmUnsubscribe.execute(token, {
      ip: req.ip ?? null,
      userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
      requestId: currentRequestId() ?? null,
    });
  }
}
