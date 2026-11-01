import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  TokenService,
  isTenantPayload,
  type TenantJwtPayload,
} from '../../../shared/crypto/token.service';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  UserMfaService,
  type SecondFactor,
  type UserMfaEnrollment,
  type UserMfaStatus,
} from '../../auth/application/user-mfa.service';
import { SessionClaimsService } from '../../auth/application/session-claims.service';
import {
  DeliveredSession,
  SessionCookieService,
} from '../../auth/presentation/session-cookie.service';
import { lockedOr } from '../../auth/presentation/locked-response';
import { AuthTokensDto } from '../../auth/presentation/dto/auth-tokens.dto';
import { MfaEnrollmentDto } from '../../auth/presentation/dto/login-mfa.dto';
import {
  ConfirmMyMfaDto,
  MyMfaEnabledDto,
  MyMfaStatusDto,
  ReauthMfaDto,
  RecoveryCodesDto,
  StartMyMfaDto,
} from './dto/my-mfa.dto';

const TOO_MANY = {
  description:
    'Demasiados códigos fallidos (5 → espera creciente; el mismo contador que el login). `Retry-After` con los segundos.',
};

/**
 * DX-021: verificación en dos pasos desde «Mi perfil → Seguridad». Solo con
 * sesión de clínica normal (no la de plataforma ni la break-glass): los
 * eventos van a la auditoría de esa clínica. Contraseña y código erróneos son
 * 400 (no 401: el cliente reintenta los 401 con un refresh y el intento
 * contaría dos veces).
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
// Todos los roles: cada miembro gestiona su propia verificación.
@Roles(
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
)
@Controller('me/mfa')
export class MyMfaController {
  constructor(
    private readonly mfa: UserMfaService,
    private readonly sessions: SessionClaimsService,
    private readonly tokens: TokenService,
    private readonly cookie: SessionCookieService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private context(req: AuditableRequest): {
    user: TenantJwtPayload;
    ctx: AuditRequestContext;
  } {
    const user = req.user;
    if (!isTenantPayload(user) || user.breakGlass) {
      throw new ForbiddenException(
        'La verificación en dos pasos se gestiona desde tu propia sesión.',
      );
    }
    return { user, ctx: requireAuditRequestContext(req, this.tenantContext) };
  }

  /** Tras subir `tokenVersion`: el par nuevo de ESTA sesión (las demás quedan cerradas). */
  private async reissue(
    req: AuditableRequest,
    res: Response,
    tv: number,
  ): Promise<DeliveredSession> {
    const { claims } = await this.sessions.current(req.user);
    const pair = await this.tokens.issue({ ...claims, tv });
    return this.cookie.deliver(res, pair, this.cookie.wantsCookie(req));
  }

  @Get()
  @ApiOperation({ summary: 'Estado de tu verificación en dos pasos' })
  @ApiOkResponse({ type: MyMfaStatusDto })
  status(@Req() req: AuditableRequest): Promise<UserMfaStatus> {
    const { user } = this.context(req);
    return this.mfa.status(user.sub, user.tenantId, user.role);
  }

  @Post('enrollment')
  @HttpCode(200)
  @RateLimit('password')
  @ApiOperation({
    summary:
      'Inicia el alta: con tu contraseña, genera el secreto (pendiente) y el otpauth URI para el QR',
  })
  @ApiOkResponse({ type: MfaEnrollmentDto })
  @ApiBadRequestResponse({ description: 'Contraseña incorrecta' })
  @ApiConflictResponse({ description: 'Ya está activa' })
  start(
    @Req() req: AuditableRequest,
    @Body() dto: StartMyMfaDto,
  ): Promise<UserMfaEnrollment> {
    const { user, ctx } = this.context(req);
    return this.mfa.startEnrollment(user.sub, dto.currentPassword, ctx);
  }

  @Post('enrollment/confirm')
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Confirma el alta con un código de la app: la activa, devuelve 10 códigos de recuperación y cierra tus demás sesiones',
    description:
      'Queda en la auditoría (UPDATE STAFF_MEMBER, `MFA_ENABLED`) sin secreto ni códigos.',
  })
  @ApiOkResponse({ type: MyMfaEnabledDto })
  @ApiBadRequestResponse({
    description: 'Código incorrecto o sin alta pendiente',
  })
  @ApiConflictResponse({ description: 'Ya está activa' })
  @ApiTooManyRequestsResponse(TOO_MANY)
  async confirm(
    @Req() req: AuditableRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ConfirmMyMfaDto,
  ): Promise<UserMfaStatus & DeliveredSession & { recoveryCodes: string[] }> {
    const { user, ctx } = this.context(req);
    try {
      const enabled = await this.mfa.confirmEnrollment(user.sub, dto.code, ctx);
      const session = await this.reissue(req, res, enabled.tokenVersion);
      return {
        ...(await this.mfa.status(user.sub, user.tenantId, user.role)),
        recoveryCodes: enabled.recoveryCodes,
        ...session,
      };
    } catch (err) {
      throw lockedOr(err, res);
    }
  }

  @Post('disable')
  @HttpCode(200)
  @RateLimit('password')
  @ApiOperation({
    summary:
      'Desactiva la verificación: contraseña actual + código de la app (o de recuperación); cierra tus demás sesiones',
    description:
      'No se puede si es obligatoria para ti (cuenta de soporte o clínica que la exige a los ADMIN). Queda en la auditoría (`MFA_DISABLED`).',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiBadRequestResponse({ description: 'Contraseña o código incorrectos' })
  @ApiForbiddenResponse({ description: 'Obligatoria para ti' })
  @ApiConflictResponse({ description: 'No está activa' })
  @ApiTooManyRequestsResponse(TOO_MANY)
  async disable(
    @Req() req: AuditableRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ReauthMfaDto,
  ): Promise<DeliveredSession> {
    const { user, ctx } = this.context(req);
    try {
      const tv = await this.mfa.disable(
        user.sub,
        dto.currentPassword,
        factorOf(dto),
        {
          ...ctx,
          role: user.role,
        },
      );
      return await this.reissue(req, res, tv);
    } catch (err) {
      throw lockedOr(err, res);
    }
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @RateLimit('password')
  @ApiOperation({
    summary:
      'Genera 10 códigos de recuperación nuevos (los anteriores dejan de valer): contraseña + código',
    description: 'Queda en la auditoría (`MFA_RECOVERY_CODES_REGENERATED`).',
  })
  @ApiOkResponse({ type: RecoveryCodesDto })
  @ApiBadRequestResponse({ description: 'Contraseña o código incorrectos' })
  @ApiConflictResponse({ description: 'No está activa' })
  @ApiTooManyRequestsResponse(TOO_MANY)
  async regenerate(
    @Req() req: AuditableRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ReauthMfaDto,
  ): Promise<RecoveryCodesDto> {
    const { user, ctx } = this.context(req);
    try {
      return {
        recoveryCodes: await this.mfa.regenerateRecoveryCodes(
          user.sub,
          dto.currentPassword,
          factorOf(dto),
          ctx,
        ),
      };
    } catch (err) {
      throw lockedOr(err, res);
    }
  }
}

function factorOf(dto: ReauthMfaDto): SecondFactor {
  if ((dto.code === undefined) === (dto.recoveryCode === undefined)) {
    throw new BadRequestException(
      'Indica el código de la app o un código de recuperación (uno de los dos).',
    );
  }
  return { code: dto.code, recoveryCode: dto.recoveryCode };
}
