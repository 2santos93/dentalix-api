import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
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
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { currentRequestId } from '../../../shared/observability/request-context';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { UserSessionsService } from '../application/user-sessions.service';
import { SESSION_MESSAGES } from '../domain/user-sessions';
import { NotMeDto, NotMeResultDto } from './dto/user-sessions.dto';

/**
 * DX-137: el enlace «No fui yo» del aviso de inicio de sesión nuevo. Público,
 * en el host de la clínica donde se entró (el enlace de otra no existe aquí).
 * Un solo uso, 24 h. Cierra TODAS las sesiones de la cuenta y devuelve un
 * enlace de restablecimiento para cambiar la contraseña ya. Mismo error para
 * todo enlace que no vale (no dice de quién es ni por qué); mismo balde de
 * rate limit que el restablecimiento de contraseña.
 */
@ApiTags('auth')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('password-reset')
@Controller('auth/session-alerts')
export class SessionAlertsController {
  constructor(private readonly sessions: UserSessionsService) {}

  @Post('not-me')
  @HttpCode(200)
  @ApiOperation({
    summary: '«No fui yo»: cierra todas las sesiones de la cuenta del aviso',
    description:
      'Cierra todas las sesiones de la cuenta, deja sin valor los enlaces de restablecimiento vivos y envía uno nuevo al email de la cuenta (como «¿Olvidaste tu contraseña?»). Queda auditado (SESSION, DELETE, `SESSION_NOT_ME`) con cuántas sesiones se cerraron. La respuesta no lleva tokens, email ni nombre.',
  })
  @ApiOkResponse({ type: NotMeResultDto })
  @ApiNotFoundResponse({ description: SESSION_MESSAGES.alertInvalid })
  notMe(
    @Req() req: TenantHostRequest & { ip?: string },
    @Body() dto: NotMeDto,
  ): Promise<NotMeResultDto> {
    const tenantId = req.tenantHost?.tenantId;
    if (!tenantId) throw new NotFoundException(SESSION_MESSAGES.alertInvalid);
    const userAgent = req.headers['user-agent'];
    return this.sessions.notMe(
      tenantId,
      dto.token,
      {
        requestId: currentRequestId() ?? null,
        ip: req.ip ?? null,
        userAgent:
          (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
      },
      req.tenantHost?.host,
    );
  }
}
