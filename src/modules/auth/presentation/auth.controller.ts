import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentRequestId } from '../../../shared/observability/request-context';
import { ConfigService } from '@nestjs/config';
import {
  ApiExtraModels,
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import {
  LoginUseCase,
  isBreakGlassSession,
  isMfaChallenge,
  type LoginResult,
} from '../application/use-cases/login.use-case';
import { RefreshUseCase } from '../application/use-cases/refresh.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  RegisterAcceptedDto,
  RegisterVerifiedDto,
  VerifyRegistrationDto,
} from './dto/register-response.dto';
import {
  PublicWebProtocol,
  platformLinkHost,
  resolvePublicWebProtocol,
} from '../../../shared/tenancy/public-link';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import {
  DeliveredSession,
  SessionCookieService,
} from './session-cookie.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import { LoginLockoutService } from '../application/login-lockout.service';
import { lockedOr } from './locked-response';
import { MfaChallengeDto } from './dto/login-mfa.dto';

/** SEC-008: respuesta del login break-glass (solo access token). */
interface BreakGlassResponse {
  accessToken: string;
  breakGlass: true;
  expiresAt: string;
}

/** DX-021: falta el segundo factor (o su alta forzada); sin tokens de sesión. */
interface MfaChallengeResponse {
  mfa: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  mfaToken: string;
  expiresAt: string;
}

function userAgentOf(req: TenantHostRequest): string | null {
  const value = req.headers['user-agent'];
  return (Array.isArray(value) ? value[0] : value) || null;
}

export const REGISTER_ACCEPTED_MESSAGE =
  'Te enviamos un correo para confirmar el registro. Abre el enlace para activar tu clínica (revisa también la carpeta de spam).';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshUseCase,
    private readonly logout: LogoutUseCase,
    private readonly lockout: LoginLockoutService,
    private readonly cookie: SessionCookieService,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
    this.baseDomains = (
      config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost'
    )
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  private readonly protocol: PublicWebProtocol;
  /** Dominios de la plataforma: el enlace del registro solo apunta a ellos. */
  private readonly baseDomains: string[];

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

  /**
   * DX-029: siempre 202 con el mismo cuerpo, exista o no el email (sin
   * enumeración). Si el email es nuevo llega un enlace de verificación; si ya
   * tenía cuenta, su titular recibe un aviso. 409 solo si el SUBDOMINIO está
   * ocupado (público: es el host de la clínica).
   */
  @Post('register')
  @HttpCode(202)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Pide el alta de una clínica: envía un enlace de verificación al email (la clínica se crea al abrirlo)',
  })
  @ApiAcceptedResponse({ type: RegisterAcceptedDto })
  @ApiConflictResponse({ description: 'El subdominio ya está en uso' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, o la petición no llegó por un host de Dentalix (el enlace del email solo apunta a la plataforma)',
  })
  async register(
    @Req() req: TenantHostRequest,
    @Body() dto: RegisterDto,
  ): Promise<RegisterAcceptedDto> {
    // Solo un host de Dentalix: el enlace lleva el token (ver platformLinkHost).
    const host = platformLinkHost(req.tenantHost?.host, this.baseDomains);
    if (!host) {
      throw new BadRequestException('Host inválido');
    }
    await this.registerClinic.accept({
      ...dto,
      linkBase: `${this.protocol}://${host}`,
    });
    return { message: REGISTER_ACCEPTED_MESSAGE };
  }

  /**
   * Abre el enlace del email con la contraseña del registro: crea la clínica y
   * su dueño (email verificado). Mismo rate limit `auth` que el registro.
   */
  @Post('register/verify')
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Confirma el registro con el token del email y crea la clínica y su dueño',
  })
  @ApiCreatedResponse({ type: RegisterVerifiedDto })
  @ApiNotFoundResponse({
    description:
      'Genérico: enlace inexistente o ya usado, o contraseña distinta de la del registro',
  })
  @ApiGoneResponse({ description: 'Enlace caducado' })
  @ApiConflictResponse({ description: 'Subdominio o email ya en uso' })
  verifyRegistration(
    @Body() dto: VerifyRegistrationDto,
    @Req() req: Request,
  ): Promise<RegisterVerifiedDto> {
    // DX-359: el alta queda auditada (CLINIC_REGISTERED) en su transacción.
    const userAgent = req.headers['user-agent'];
    return this.registerClinic.verify(dto.token, dto.password, {
      requestId: currentRequestId() ?? null,
      ip: req.ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  /**
   * DX-048 (SEC-028): el bloqueo es por FALLOS y vive en la BD (vale entre
   * réplicas). Antes de mirar la contraseña, si la cuenta (hash del email) o
   * la IP están en espera → 429 con `Retry-After` y el mismo mensaje exista o
   * no el email. Un 401 suma un fallo a la cuenta y a la IP; un login
   * correcto reinicia la cuenta. El balde `login-burst` del rate limiter solo
   * frena avalanchas por IP (argon2 cuesta CPU) y es holgado para una clínica
   * tras NAT.
   */
  @Audit({ action: 'LOGIN', resource: 'SESSION' })
  @Post('login')
  @ApiCreatedResponse({
    description:
      'Sesión (`AuthTokensDto`) o, DX-021, el paso del segundo factor (`MfaChallengeDto`: `mfa`, `mfaToken`, `expiresAt`) que se completa en `POST /auth/login/mfa` (o en `/auth/login/mfa/enrollment*` si es un alta forzada).',
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/AuthTokensDto' },
        { $ref: '#/components/schemas/MfaChallengeDto' },
      ],
    },
  })
  @ApiExtraModels(AuthTokensDto, MfaChallengeDto)
  @ApiOperation({
    summary:
      'Inicia sesión en la clínica del host (o en plataforma desde el apex)',
    description:
      'SEC-008: un superadmin SIN membresía en la clínica solo entra como acceso de soporte (break-glass): ' +
      'necesita el MFA enrolado (`/platform/mfa`), `mfaCode` y `breakGlassReason`. Recibe solo un access token ' +
      'ADMIN de vida corta (`breakGlass: true`, `expiresAt`), sin refresh, y el acceso queda en ' +
      '`GET /support-accesses` de la clínica.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Credenciales inválidas (mismo error exista o no el email). Solo tras una contraseña correcta de superadmin sin membresía: ' +
      '`code: "MFA_NOT_ENROLLED"` (debe activar el MFA en plataforma), `code: "MFA_COOLDOWN"` (MFA recién activado: espera de seguridad hasta `availableAt`) o `code: "BREAK_GLASS_REQUIRED"` (faltan código y motivo).',
  })
  @ApiBadRequestResponse({
    description:
      '`mfaCode` no es de 6 dígitos o `breakGlassReason` no tiene 10–500 caracteres',
  })
  // Encima de @RateLimit: completa su 429 genérico con el caso del bloqueo.
  @ApiTooManyRequestsResponse({
    description:
      'Demasiados intentos fallidos de esta cuenta, desde esta IP o del código MFA de un superadmin, o avalancha de peticiones. `Retry-After` lleva los segundos de espera; el mensaje es el mismo exista o no el email.',
    headers: {
      'Retry-After': {
        description: 'Segundos que faltan para poder reintentar',
        schema: { type: 'integer', minimum: 1 },
      },
    },
  })
  @RateLimit('login-burst')
  async loginHandler(
    // `req.ip` de Express: X-Forwarded-For solo con TRUST_PROXY (SEC-031).
    @Req() req: TenantHostRequest & { ip?: string },
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDto,
  ): Promise<DeliveredSession | BreakGlassResponse | MfaChallengeResponse> {
    const tenantId = req.tenantHost?.tenantId;
    try {
      await this.lockout.assertCanAttempt(dto.email, req.ip);
    } catch (err) {
      throw lockedOr(err, res);
    }
    // Host SIN clínica (el apex): es la puerta del área de plataforma. Solo la
    // resuelve un superadmin, y recibe un token de plataforma (sin tenant ni
    // rol). Para cualquier otro usuario `executePlatform` lanza el mismo
    // 'Invalid credentials', así que no se filtra si el email existe ni si es
    // superadmin.
    let result: LoginResult;
    try {
      result = tenantId
        ? await this.login.execute({
            tenantId,
            email: dto.email,
            password: dto.password,
            mfaCode: dto.mfaCode,
            breakGlassReason: dto.breakGlassReason,
            ip: req.ip ?? null,
            userAgent: userAgentOf(req),
          })
        : await this.login.executePlatform({
            email: dto.email,
            password: dto.password,
          });
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        await this.lockout.recordFailure(dto.email, req.ip);
      }
      // SEC-008: el código MFA del break-glass tiene su propio bloqueo.
      throw lockedOr(err, res);
    }
    await this.lockout.recordSuccess(dto.email);
    if (isMfaChallenge(result)) {
      // DX-021: contraseña correcta, falta el segundo factor. Ni access ni
      // refresh (ni cookie): el token intermedio no abre ninguna ruta.
      return {
        mfa: result.mfa,
        mfaToken: result.mfaToken,
        expiresAt: result.expiresAt.toISOString(),
      };
    }
    if (isBreakGlassSession(result)) {
      // Sin refresh: y si en este navegador quedaba la cookie de una sesión
      // anterior en esta clínica, se borra para que nada renueve el acceso.
      if (this.cookie.wantsCookie(req)) this.cookie.clear(res);
      return {
        accessToken: result.accessToken,
        breakGlass: true,
        expiresAt: result.expiresAt.toISOString(),
      };
    }
    return this.cookie.deliver(res, result, this.cookie.wantsCookie(req));
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
