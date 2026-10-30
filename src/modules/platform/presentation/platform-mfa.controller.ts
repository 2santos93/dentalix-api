import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import type { PlatformJwtPayload } from '../../../shared/crypto/token.service';
import {
  PlatformMfaUseCase,
  type PlatformMfaEnrollment,
  type PlatformMfaStatus,
} from '../application/use-cases/platform-mfa.use-case';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { currentRequestId } from '../../../shared/observability/request-context';
import {
  ConfirmPlatformMfaDto,
  PlatformMfaEnrollmentDto,
  PlatformMfaStatusDto,
} from './dto/platform-mfa.dto';

/**
 * SEC-008: MFA (TOTP) del superadmin. Se enrola desde la sesión de
 * PLATAFORMA (apex) y es obligatorio para el acceso break-glass a una
 * clínica sin membresía. Sin `TenantContextInterceptor`, como el resto de
 * `/platform/*`.
 */
interface PlatformRequest {
  user: PlatformJwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** DX-359: desde dónde llega la petición, para `platform_audit_events`. */
function requestMeta(req: PlatformRequest): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform/mfa')
export class PlatformMfaController {
  constructor(private readonly mfa: PlatformMfaUseCase) {}

  @Get()
  @ApiOperation({
    summary: 'Estado de la verificación en dos pasos del superadmin',
  })
  @ApiOkResponse({ type: PlatformMfaStatusDto })
  status(@Req() req: { user: PlatformJwtPayload }): Promise<PlatformMfaStatus> {
    return this.mfa.status(req.user.sub);
  }

  @Post('enrollment')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Inicia el alta del MFA: genera un secreto (pendiente hasta confirmarlo) y devuelve el otpauth URI',
    description:
      'Queda en platform_audit_events (MFA_ENROLLMENT_STARTED) sin el secreto ni el URI.',
  })
  @ApiOkResponse({ type: PlatformMfaEnrollmentDto })
  @ApiConflictResponse({ description: 'El MFA ya está activo' })
  start(@Req() req: PlatformRequest): Promise<PlatformMfaEnrollment> {
    return this.mfa.start(req.user.sub, requestMeta(req));
  }

  @Post('enrollment/confirm')
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Confirma el alta con un código de la app y activa el MFA',
    description:
      'Queda en platform_audit_events (MFA_ENABLED) sin el código ni el secreto.',
  })
  @ApiOkResponse({ type: PlatformMfaStatusDto })
  @ApiBadRequestResponse({
    description: 'Código inválido o sin alta pendiente',
  })
  @ApiConflictResponse({ description: 'El MFA ya está activo' })
  confirm(
    @Req() req: PlatformRequest,
    @Body() dto: ConfirmPlatformMfaDto,
  ): Promise<PlatformMfaStatus> {
    return this.mfa.confirm(req.user.sub, dto.code, requestMeta(req));
  }
}
