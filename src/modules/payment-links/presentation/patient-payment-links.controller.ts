import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import {
  resolvePublicWebProtocol,
  safeLinkHost,
} from '../../../shared/tenancy/public-link';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { Audit } from '../../audit/presentation/audit.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  CreatePaymentLinkUseCase,
  ListPatientPaymentLinksUseCase,
  type CreatedPaymentLink,
  type PatientPaymentLinkView,
} from '../application/use-cases/patient-payment-links.use-cases';
import { PAYMENT_LINK_CREATED_REASON } from '../domain/payment-link';
import {
  CreatePaymentLinkDto,
  CreatedPaymentLinkDto,
  PatientPaymentLinkDto,
} from './dto/payment-link.dto';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

// «Enviar enlace de pago» desde el estado de cuenta o una cuota (DX-569):
// quien cobra (ADMIN y recepción). Ni la URL ni el token van a la auditoría.
@ApiTags('payment-links')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@ApiParam({ name: 'id', format: 'uuid', description: 'El paciente' })
@ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
@Controller('patients/:id/payment-links')
export class PatientPaymentLinksController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly createLink: CreatePaymentLinkUseCase,
    private readonly listLinks: ListPatientPaymentLinksUseCase,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT_LINK',
    resourceId: { response: 'id' },
    patient: { param: 'id' },
    reason: PAYMENT_LINK_CREATED_REASON,
  })
  @Post()
  @ApiOperation({
    summary: 'Crea (y envía) el enlace de pago de un plan o un saldo migrado',
    description:
      'DX-569. El enlace vale 7 días y cobra UN destino: un plan cobrable o un saldo migrado del paciente, en su moneda y con la sede del plan. Crear otro anula el vivo del mismo destino. La URL (con el token) solo viene en esta respuesta. Canal EMAIL: plantilla `payment-link` por el outbox; WHATSAPP: `whatsapp` con el número y el texto para wa.me, sin importes ni tratamientos; sin canal: solo la URL. Auditado como CREATE de PAYMENT_LINK.',
  })
  @ApiCreatedResponse({ type: CreatedPaymentLinkDto })
  @ApiBadRequestResponse({
    description:
      'Sin destino o con los dos, moneda distinta de la del destino, importe no válido, o el host de la petición no sirve para armar el enlace',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente, plan o saldo migrado no encontrados (o de otro paciente)',
  })
  @ApiConflictResponse({
    description:
      'El plan está rechazado o cancelado (no admite abonos), o el paciente está archivado',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'EMAIL sin email del paciente, o WHATSAPP sin un teléfono válido',
  })
  @ApiTooManyRequestsResponse({ description: 'Tope de emails del outbox' })
  create(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePaymentLinkDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedPaymentLink> {
    return this.createLink.execute(
      patientId,
      {
        target: {
          treatmentPlanId: dto.target.treatmentPlanId,
          openingBalanceId: dto.target.openingBalanceId,
        },
        amount: dto.amount,
        currency: dto.currency,
        channel: dto.channel ?? null,
      },
      req.user.sub,
      { protocol: this.protocol, host: safeLinkHost(req.tenantHost?.host) },
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Enlaces de pago del paciente con su estado',
    description:
      'DX-569. Los 100 más recientes. Estado derivado: LIVE, USED (ya tiene reporte), EXPIRED o REVOKED. Sin URL: el token no se guarda.',
  })
  @ApiOkResponse({ type: [PatientPaymentLinkDto] })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  list(
    @Param('id', ParseUUIDPipe) patientId: string,
  ): Promise<PatientPaymentLinkView[]> {
    return this.listLinks.execute(patientId);
  }
}
