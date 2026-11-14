import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { isTenantPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { UserMfaService } from '../application/user-mfa.service';
import { ResetMemberMfaDto, StaffMfaStatusDto } from './dto/staff-mfa.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles } from './guards/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import { lockedOr } from './locked-response';

/**
 * DX-021-bis: la verificación en dos pasos de OTRO miembro. Solo ADMIN, con
 * sesión propia (un acceso de soporte no resetea nada). El miembro se busca
 * bajo la RLS de la clínica: otro usuario da 404. Errores de contraseña y
 * código en 400, como `/me/mfa`.
 */
@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@Controller('staff/:userId/mfa')
export class StaffMfaController {
  constructor(
    private readonly mfa: UserMfaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: '¿Tiene este miembro la verificación activa?' })
  @ApiOkResponse({ type: StaffMfaStatusDto })
  @ApiNotFoundResponse({ description: 'No es miembro activo de esta clínica' })
  status(
    @Req() req: AuditableRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<StaffMfaStatusDto> {
    const ctx = requireAuditRequestContext(req, this.tenantContext);
    return this.mfa.memberStatus(ctx.tenantId, userId);
  }

  @Post('reset')
  @HttpCode(204)
  @RateLimit('password')
  @ApiOperation({
    summary:
      'Restablece la verificación de otro miembro: contraseña y segundo factor de quien lo hace, con motivo',
    description:
      'Borra su secreto y sus códigos, cierra sus sesiones, deja sin valor sus dispositivos de confianza y le avisa por correo. Queda en la auditoría (`MFA_RESET_<motivo>`). Nunca la propia, la de un superadmin ni la de una cuenta con acceso a otra clínica (`MFA_RESET_REFUSED`).',
  })
  @ApiNoContentResponse({ description: 'Restablecida' })
  @ApiBadRequestResponse({ description: 'Contraseña o código incorrectos' })
  @ApiForbiddenResponse({
    description: 'Cuenta de soporte, o la sesión es un acceso de soporte',
  })
  @ApiNotFoundResponse({ description: 'No es miembro activo de esta clínica' })
  @ApiConflictResponse({
    description:
      'Es la propia, no está activa, quien la pide no tiene MFA o la cuenta da acceso a otra clínica',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Demasiados códigos fallidos de quien lo pide. `Retry-After` con los segundos.',
  })
  async reset(
    @Req() req: AuditableRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ResetMemberMfaDto,
  ): Promise<void> {
    if (!isTenantPayload(req.user) || req.user.breakGlass) {
      throw new ForbiddenException(
        'La verificación en dos pasos se gestiona desde tu propia sesión.',
      );
    }
    try {
      await this.mfa.resetForMember(
        userId,
        {
          currentPassword: dto.currentPassword,
          factor: { code: dto.code, recoveryCode: dto.recoveryCode },
          reason: dto.reason,
        },
        requireAuditRequestContext(req, this.tenantContext),
      );
    } catch (err) {
      throw lockedOr(err, res);
    }
  }
}
