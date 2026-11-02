import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import type { PlatformJwtPayload } from '../../../shared/crypto/token.service';
import {
  PlatformMfaUseCase,
  type PlatformMfaStatus,
} from '../application/use-cases/platform-mfa.use-case';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { currentRequestId } from '../../../shared/observability/request-context';
import { lockedOr } from '../../auth/presentation/locked-response';
import {
  ReauthMfaDto,
  RecoveryCodesDto,
} from '../../me/presentation/dto/my-mfa.dto';
import { PlatformMfaStatusDto } from './dto/platform-mfa.dto';

/**
 * SEC-008: MFA (TOTP) del superadmin. DX-021-bis: se enrola en el login del
 * apex, sin el que no hay sesión de plataforma; aquí se consulta y se renuevan
 * los códigos de recuperación. Sin `TenantContextInterceptor`, como el resto de
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

  @Post('recovery-codes')
  @HttpCode(200)
  @RateLimit('password')
  @ApiOperation({
    summary:
      'Genera 10 códigos de recuperación nuevos (los anteriores dejan de valer): contraseña + código',
    description:
      'Queda en platform_audit_events (MFA_RECOVERY_CODES_REGENERATED) sin los códigos.',
  })
  @ApiOkResponse({ type: RecoveryCodesDto })
  @ApiBadRequestResponse({ description: 'Contraseña o código incorrectos' })
  @ApiConflictResponse({ description: 'El MFA no está activo' })
  @ApiTooManyRequestsResponse({
    description: 'Demasiados códigos fallidos. `Retry-After` con los segundos.',
  })
  async regenerate(
    @Req() req: PlatformRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ReauthMfaDto,
  ): Promise<RecoveryCodesDto> {
    try {
      return {
        recoveryCodes: await this.mfa.regenerateRecoveryCodes(
          { userId: req.user.sub, ...requestMeta(req) },
          dto.currentPassword,
          { code: dto.code, recoveryCode: dto.recoveryCode },
        ),
      };
    } catch (err) {
      throw lockedOr(err, res);
    }
  }
}
