import {
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { CreateConfirmationLinkUseCase } from '../application/use-cases/create-confirmation-link.use-case';
import { ConfirmationLinkDto } from './dto/appointment-confirmation.dto';
import { buildConfirmationUrl } from './confirmation-url';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { JwtPayload } from '../../../shared/crypto/token.service';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

// Mismos roles que el resto de la agenda (APPOINTMENT_ROLES): quien puede
// gestionar una cita puede pedirle confirmación al paciente — recepción
// incluida, que es quien de hecho lo hace.
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('appointments')
export class ConfirmationLinksController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly createLink: CreateConfirmationLinkUseCase,
    config: ConfigService,
  ) {
    const configured = config.get<string>('PUBLIC_WEB_PROTOCOL');
    this.protocol =
      configured === 'http' || configured === 'https'
        ? configured
        : config.get<string>('NODE_ENV') === 'production'
          ? 'https'
          : 'http';
  }

  @Post(':id/confirmation-link')
  @ApiCreatedResponse({ type: ConfirmationLinkDto })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConfirmationLinkDto> {
    // TenantContextInterceptor ya exigió que el host resuelva a la clínica
    // del JWT, así que `host` es SIEMPRE un host de esta clínica.
    const host = req.tenantHost?.host;
    if (!host) {
      throw new NotFoundException('Appointment not found');
    }
    const result = await this.createLink.execute({
      appointmentId: id,
      createdById: req.user.sub,
    });
    return {
      url: buildConfirmationUrl(this.protocol, host, result.token),
      expiresAt: result.expiresAt,
      whatsappPhone: result.whatsappPhone,
      appointment: result.appointment,
    };
  }
}
