import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { RefreshUseCase } from '../application/use-cases/refresh.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { RegisterResponseDto } from './dto/register-response.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import {
  DeliveredSession,
  SessionCookieService,
} from './session-cookie.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshUseCase,
    private readonly logout: LogoutUseCase,
    private readonly cookie: SessionCookieService,
  ) {}

  /**
   * Refresh de la petición: el del body si viene (clientes antiguos y la
   * migración de la web), si no el de la cookie. Usar la cookie exige un
   * `Origin` de la propia clínica (CSRF, además de SameSite=Strict).
   */
  private refreshOf(
    req: TenantHostRequest,
    fromBody: string | undefined,
  ): { token: string | undefined; viaCookie: boolean } {
    if (fromBody) return { token: fromBody, viaCookie: false };
    const fromCookie = this.cookie.read(req);
    if (fromCookie) this.cookie.assertTrustedOrigin(req);
    return { token: fromCookie, viaCookie: Boolean(fromCookie) };
  }

  @Post('register')
  @RateLimit('auth')
  @ApiCreatedResponse({ type: RegisterResponseDto })
  register(
    @Body() dto: RegisterDto,
  ): Promise<{ tenantId: string; userId: string }> {
    return this.registerClinic.execute(dto);
  }

  @Post('login')
  @RateLimit('auth', 'login', 'login-account')
  @ApiCreatedResponse({ type: AuthTokensDto })
  async loginHandler(
    @Req() req: TenantHostRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDto,
  ): Promise<DeliveredSession> {
    const tenantId = req.tenantHost?.tenantId;
    // Host SIN clínica (el apex): es la puerta del área de plataforma. Solo la
    // resuelve un superadmin, y recibe un token de plataforma (sin tenant ni
    // rol). Para cualquier otro usuario `executePlatform` lanza el mismo
    // 'Invalid credentials', así que no se filtra si el email existe ni si es
    // superadmin.
    const pair = tenantId
      ? await this.login.execute({
          tenantId,
          email: dto.email,
          password: dto.password,
        })
      : await this.login.executePlatform({
          email: dto.email,
          password: dto.password,
        });
    return this.cookie.deliver(res, pair, this.cookie.wantsCookie(req));
  }

  // Renovación: el tenant va dentro del refresh token. Por cookie, la sesión
  // tiene que ser de la clínica del host (`null` en el apex = plataforma): la
  // cookie de una clínica no renueva en otra. Por body se comprueba solo si el
  // host resuelve una clínica (los clientes antiguos pueden no mandar host).
  // Un 401 significa que el refresh no vale y el cliente vuelve a /login; en
  // modo cookie, además, se borra la cookie muerta.
  @Post('refresh')
  @RateLimit('refresh')
  @ApiCreatedResponse({ type: AuthTokensDto })
  async refreshHandler(
    @Req() req: TenantHostRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RefreshDto,
  ): Promise<DeliveredSession> {
    const { token, viaCookie } = this.refreshOf(req, dto.refreshToken);
    if (!token) throw new UnauthorizedException('Missing refresh token');
    const hostTenantId = req.tenantHost?.tenantId ?? null;
    const cookieMode = viaCookie || this.cookie.wantsCookie(req);
    try {
      const pair = await this.refresh.execute({
        refreshToken: token,
        expectedTenantId: viaCookie
          ? hostTenantId
          : (hostTenantId ?? undefined),
      });
      return this.cookie.deliver(res, pair, cookieMode);
    } catch (err) {
      // Solo un 401 dice que la cookie está muerta; un 5xx transitorio no.
      if (viaCookie && err instanceof UnauthorizedException) {
        this.cookie.clear(res);
      }
      throw err;
    }
  }

  // Cierre de sesión: revoca el refresh token (denylist por jti), del body o
  // de la cookie, y borra la cookie. No requiere guard ni tenant host (la
  // identidad va en el propio token). Idempotente → 204 aunque el token sea
  // inválido/expirado o no haya ninguno.
  @Post('logout')
  @HttpCode(204)
  async logoutHandler(
    @Req() req: TenantHostRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LogoutDto,
  ): Promise<void> {
    const { token } = this.refreshOf(req, dto.refreshToken);
    if (token) await this.logout.execute({ refreshToken: token });
    this.cookie.clear(res);
  }
}
