import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { CHECK_IN_SETTINGS_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CheckInSettingsUseCases,
  type CreatedCheckInQr,
} from '../application/check-in-settings.use-cases';
import type { LocationCheckInSettingsView } from '../domain/ports/check-in-repository.port';
import {
  CheckInSettingsDto,
  CreatedCheckInQrDto,
  UpdateCheckInSettingsDto,
} from './dto/check-in.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const FORBIDDEN_MESSAGE =
  'Solo la administración cambia la llegada de pacientes de una sede.';

/**
 * DX-265: Ajustes › Llegada de pacientes, por sede. Solo ADMIN. Auditado como
 * UPDATE de LOCATION con su motivo (nunca el token del QR).
 */
@ApiTags('self-check-in')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CHECK_IN_SETTINGS_ROLES)
@RolesDeniedMessage(FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({
  description: `${FORBIDDEN_MESSAGE} (o sede no permitida)`,
})
@Controller('locations/:locationId/check-in-settings')
export class CheckInSettingsController {
  constructor(private readonly settings: CheckInSettingsUseCases) {}

  @Get()
  @ApiOperation({
    summary: '«Ya llegué» de la sede: ventana, retraso, enlace y QR',
  })
  @ApiOkResponse({ type: CheckInSettingsDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada o retirada' })
  get(
    @Param('locationId', ParseUUIDPipe) locationId: string,
  ): Promise<LocationCheckInSettingsView> {
    return this.settings.get(locationId);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CHECK_IN_SETTINGS_UPDATED',
  })
  @Patch()
  @ApiOperation({
    summary: 'Cambiar la ventana, el umbral de retraso o el enlace',
  })
  @ApiOkResponse({ type: CheckInSettingsDto })
  @ApiBadRequestResponse({ description: 'Minutos fuera de 0–240' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada o retirada' })
  update(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: UpdateCheckInSettingsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LocationCheckInSettingsView> {
    return this.settings.update(
      locationId,
      {
        linkEnabled: dto.linkEnabled,
        minutesBefore: dto.minutesBefore,
        minutesAfter: dto.minutesAfter,
        lateMinutes: dto.lateMinutes,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CHECK_IN_QR_CREATED',
  })
  @Post('qr')
  @ApiOperation({
    summary: 'Generar el QR de llegada de la sede',
    description:
      'Devuelve el token del cartel `/llegada/<token>` UNA sola vez (en la BD, su hash). Si la sede ya tenía uno, deja de valer.',
  })
  @ApiCreatedResponse({ type: CreatedCheckInQrDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada o retirada' })
  createQr(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedCheckInQr> {
    return this.settings.createQr(locationId, req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CHECK_IN_QR_REVOKED',
  })
  @Post('qr/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Retirar el QR de llegada de la sede',
    description:
      'El cartel deja de valer en la siguiente lectura («Este código ya no está activo»). Idempotente.',
  })
  @ApiOkResponse({ type: CheckInSettingsDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada o retirada' })
  revokeQr(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<LocationCheckInSettingsView> {
    return this.settings.revokeQr(locationId, req.user.sub);
  }
}
