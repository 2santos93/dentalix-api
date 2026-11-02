import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { currentRequestId } from '../../../shared/observability/request-context';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { CompleteMfaLoginUseCase } from '../application/use-cases/complete-mfa-login.use-case';
import type { UserMfaEnrollment } from '../application/user-mfa.service';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import {
  ConfirmLoginMfaEnrollmentDto,
  MfaEnrolledSessionDto,
  MfaEnrollmentDto,
  StartLoginMfaEnrollmentDto,
  VerifyLoginMfaDto,
} from './dto/login-mfa.dto';
import { lockedOr } from './locked-response';
import {
  DeliveredSession,
  SessionCookieService,
} from './session-cookie.service';

type HostRequest = TenantHostRequest & { ip?: string };

function requestMeta(req: HostRequest): AuditRequestMeta {
  const ua = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null,
  };
}

const TOO_MANY = {
  description:
    'Demasiados códigos fallidos de esta cuenta (5 → espera creciente, el mismo contador que el MFA del superadmin) o avalancha de peticiones. `Retry-After` con los segundos.',
};

/**
 * DX-021: segundo paso del login de clínica. Público (sin JwtAuthGuard): se
 * autentica con el `mfaToken` del primer paso, que solo vale en la clínica
 * del host. Rate limit `auth` por IP además del contador por usuario.
 */
@ApiTags('auth')
@Controller('auth/login/mfa')
export class LoginMfaController {
  constructor(
    private readonly login: CompleteMfaLoginUseCase,
    private readonly cookie: SessionCookieService,
  ) {}

  @Post()
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Completa el login con el código de la app o un código de recuperación',
    description:
      'Queda en la auditoría de la clínica: LOGIN (`MFA_TOTP` / `MFA_RECOVERY_CODE`) o LOGIN_FAILED (`INVALID_MFA_CODE`). Un código de la app vale una sola vez; uno de recuperación, también.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiBadRequestResponse({ description: 'Falta el código o vienen los dos' })
  @ApiUnauthorizedResponse({
    description:
      '`code: "MFA_INVALID_CODE"` (código erróneo o ya usado) o `code: "MFA_CHALLENGE_EXPIRED"` (token intermedio caducado, usado o de otra clínica: volver a iniciar sesión)',
  })
  @ApiTooManyRequestsResponse(TOO_MANY)
  async verify(
    @Req() req: HostRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: VerifyLoginMfaDto,
  ): Promise<DeliveredSession> {
    if ((dto.code === undefined) === (dto.recoveryCode === undefined)) {
      throw new BadRequestException(
        'Indica el código de la app o un código de recuperación (uno de los dos).',
      );
    }
    try {
      const pair = await this.login.verify({
        mfaToken: dto.mfaToken,
        hostTenantId: req.tenantHost?.tenantId ?? undefined,
        factor: { code: dto.code, recoveryCode: dto.recoveryCode },
        request: requestMeta(req),
      });
      return this.cookie.deliver(res, pair, this.cookie.wantsCookie(req));
    } catch (err) {
      throw lockedOr(err, res);
    }
  }

  @Post('enrollment')
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Alta forzada: genera el secreto (pendiente) y el otpauth URI',
  })
  @ApiOkResponse({ type: MfaEnrollmentDto })
  @ApiUnauthorizedResponse({ description: '`code: "MFA_CHALLENGE_EXPIRED"`' })
  @ApiConflictResponse({ description: 'La verificación ya está activa' })
  startEnrollment(
    @Req() req: HostRequest,
    @Body() dto: StartLoginMfaEnrollmentDto,
  ): Promise<UserMfaEnrollment> {
    return this.login.startEnrollment({
      mfaToken: dto.mfaToken,
      hostTenantId: req.tenantHost?.tenantId ?? undefined,
      request: requestMeta(req),
    });
  }

  @Post('enrollment/confirm')
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Alta forzada: confirma con un código, activa la verificación y abre la sesión',
    description:
      'Devuelve los 10 códigos de recuperación (una sola vez). Queda auditado (UPDATE STAFF_MEMBER `MFA_ENABLED` y LOGIN `MFA_ENROLLED`).',
  })
  @ApiOkResponse({ type: MfaEnrolledSessionDto })
  @ApiBadRequestResponse({ description: 'Código erróneo o sin alta pendiente' })
  @ApiUnauthorizedResponse({ description: '`code: "MFA_CHALLENGE_EXPIRED"`' })
  @ApiTooManyRequestsResponse(TOO_MANY)
  async confirmEnrollment(
    @Req() req: HostRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ConfirmLoginMfaEnrollmentDto,
  ): Promise<DeliveredSession & { recoveryCodes: string[] }> {
    try {
      const { recoveryCodes, ...pair } = await this.login.confirmEnrollment({
        mfaToken: dto.mfaToken,
        hostTenantId: req.tenantHost?.tenantId ?? undefined,
        code: dto.code,
        request: requestMeta(req),
      });
      return {
        ...this.cookie.deliver(res, pair, this.cookie.wantsCookie(req)),
        recoveryCodes,
      };
    } catch (err) {
      throw lockedOr(err, res);
    }
  }
}
