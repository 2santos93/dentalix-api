import {
  BadRequestException,
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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateConfirmationLinkUseCase } from '../application/use-cases/create-confirmation-link.use-case';
import { ConfirmationLinkDto } from './dto/appointment-confirmation.dto';
import { buildConfirmationUrl, safeLinkHost } from './confirmation-url';
import { resolvePublicWebProtocol } from '../../../shared/tenancy/public-link';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  requireAuditRequestContext,
} from '../../audit/presentation/audit-request-context';
import { AnamnesisReminderLinks } from '../../medical-history-submissions/application/anamnesis-reminder-links';
import { buildAnamnesisUrl } from '../../medical-history-submissions/domain/anamnesis-token';

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
    private readonly tenantContext: TenantContextService,
    private readonly anamnesisLinks: AnamnesisReminderLinks,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  @Post(':id/confirmation-link')
  @ApiOperation({
    summary:
      'Genera (o reenvía) el enlace de confirmación de la cita; el anterior deja de valer',
    description:
      'DX-361: queda en la auditoría como UPDATE de APPOINTMENT (la cita), origen STAFF y `reason` CONFIRMATION_LINK_CREATED, o CONFIRMATION_LINK_RESENT si la cita ya tenía un enlace enviado. Sin el token ni la URL. DX-290: si la sede envía la anamnesis con el recordatorio y el paciente es nuevo o su anamnesis caduca el día de la cita, también emite su enlace de anamnesis (`anamnesisUrl`, para el mensaje de WhatsApp) si no tiene ya uno vivo; con uno vivo no emite otro ni lo anula (`anamnesisPending`) y lo audita como CREATE de MEDICAL_HISTORY_SUBMISSION (ANAMNESIS_LINK_CREATED).',
  })
  @ApiCreatedResponse({ type: ConfirmationLinkDto })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConfirmationLinkDto> {
    // TenantContextInterceptor ya exigió que el host resuelva a la clínica
    // del JWT, pero la resolución ignora lo que va tras el `:`: se valida el
    // host entero ANTES de emitir (un host manipulado no debe ni revocar el
    // enlace vigente). Ver SAFE_HOST en confirmation-url.ts.
    if (!req.tenantHost?.host) {
      throw new NotFoundException('Cita no encontrada');
    }
    const host = safeLinkHost(req.tenantHost.host);
    if (!host) {
      throw new BadRequestException('El dominio de la solicitud no es válido.');
    }
    const result = await this.createLink.execute({
      appointmentId: id,
      createdById: req.user.sub,
      audit: auditRequestContext(req, this.tenantContext),
    });
    // DX-290: el de anamnesis va en el mismo mensaje, por el mismo host.
    const anamnesis = await this.anamnesisLinks.issueForAppointmentId(
      id,
      {
        kind: 'STAFF',
        audit: requireAuditRequestContext(req, this.tenantContext),
      },
      new Date(),
    );
    return {
      url: buildConfirmationUrl(this.protocol, host, result.token),
      expiresAt: result.expiresAt,
      whatsappPhone: result.whatsappPhone,
      appointment: result.appointment,
      anamnesisUrl: anamnesis.issued
        ? buildAnamnesisUrl(this.protocol, host, anamnesis.token)
        : null,
      anamnesisPending: !anamnesis.issued && anamnesis.reason === 'LIVE_LINK',
    };
  }
}
