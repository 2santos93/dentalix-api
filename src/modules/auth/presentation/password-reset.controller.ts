import {
  Body,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RequestPasswordResetUseCase } from '../application/use-cases/request-password-reset.use-case';
import {
  RESET_TOKEN_MESSAGES,
  ResetPasswordUseCase,
} from '../application/use-cases/reset-password.use-case';
import {
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  PasswordResetTokenDto,
  PasswordResetTokenStatusDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';

export const FORGOT_PASSWORD_MESSAGE =
  'Si el correo pertenece a una cuenta de esta clínica, te enviamos un enlace para restablecer la contraseña. Revisa también la carpeta de spam.';

type PublicRequest = TenantHostRequest & { ip?: string };

function header(req: PublicRequest, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Recuperar la contraseña por email (DX-010). Rutas PÚBLICAS de la clínica del
 * host: no hay sesión (de eso se trata) y la clínica sale solo del host
 * resuelto por el servidor. Rate limit propio por IP (`password-reset`), un
 * balde por ruta.
 */
@ApiTags('auth')
@UseInterceptors(PublicTenantContextInterceptor)
@RateLimit('password-reset')
@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    private readonly requestReset: RequestPasswordResetUseCase,
    private readonly resetPassword: ResetPasswordUseCase,
    private readonly links: TenantLinkBaseService,
  ) {}

  /**
   * Siempre 202 con el mismo cuerpo, exista o no el email, esté o no activo,
   * y sin esperar a nada que dependa de ello: la búsqueda, el token y el
   * encolado del email corren en segundo plano.
   *
   * SEC-033: el token restablece la contraseña GLOBAL, así que el enlace va
   * siempre al host de plataforma de la clínica (`<subdominio>.<dominio
   * base>`), también si la petición llegó por su dominio personalizado (cuyo
   * DNS controla la clínica). Lo que se espera aquí depende solo del host,
   * nunca del email.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto })
  async forgotPassword(
    @Req() req: PublicRequest,
    @Body() dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    const tenantId = req.tenantHost?.tenantId;
    if (tenantId) {
      // Un fallo leyendo el subdominio no puede cambiar la respuesta (ni
      // volverla un 500): sin enlace seguro, no se envía nada.
      const linkBase = await this.links
        .forTenant(tenantId, req.tenantHost?.host)
        .catch((err: unknown) => {
          this.logger.warn({
            event: 'password_reset.link_base_failed',
            tenantId,
            error: err instanceof Error ? err.constructor.name : typeof err,
          });
          return null;
        });
      if (linkBase) {
        this.requestReset.accept({ tenantId, email: dto.email, linkBase });
      }
    }
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  /** Estado del enlace, para que la web ofrezca pedir otro si no sirve. */
  @Post('reset-password/check')
  @HttpCode(200)
  @ApiOkResponse({ type: PasswordResetTokenStatusDto })
  async check(
    @Req() req: PublicRequest,
    @Body() dto: PasswordResetTokenDto,
  ): Promise<PasswordResetTokenStatusDto> {
    const tenantId = req.tenantHost?.tenantId;
    if (!tenantId) return { status: 'INVALID' };
    return {
      status: await this.resetPassword.status({ tenantId, token: dto.token }),
    };
  }

  /**
   * Cambia la contraseña con un enlace válido, lo consume y cierra TODAS las
   * sesiones del usuario. No abre sesión: la web lleva al login.
   */
  @Post('reset-password')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Contraseña restablecida.' })
  @ApiNotFoundResponse({ description: 'Enlace inexistente o reemplazado.' })
  @ApiGoneResponse({ description: 'Enlace caducado o ya usado.' })
  async reset(
    @Req() req: PublicRequest,
    @Body() dto: ResetPasswordDto,
  ): Promise<void> {
    const tenantId = req.tenantHost?.tenantId;
    if (!tenantId) throw new NotFoundException(RESET_TOKEN_MESSAGES.INVALID);
    await this.resetPassword.execute({
      tenantId,
      token: dto.token,
      password: dto.password,
      meta: {
        ip: req.ip ?? null,
        userAgent: header(req, 'user-agent'),
        requestId: currentRequestId() ?? null,
      },
    });
  }
}
