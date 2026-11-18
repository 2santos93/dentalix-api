import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
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
  CreateAccessLinkUseCase,
  ListAccessLinksUseCase,
  RevokeAccessLinkUseCase,
} from '../application/use-cases/staff-access-links.use-cases';
import {
  PATIENT_ACCESS_LINK_CREATED_REASON,
  PATIENT_ACCESS_LINK_REVOKED_REASON,
} from '../domain/patient-access';
import {
  AccessLinkDto,
  CreateAccessLinkDto,
  CreatedAccessLinkDto,
} from './dto/patient-access.dto';

type AuthenticatedRequest = TenantHostRequest & { user: JwtPayload };

// «Compartir con el paciente» (DX-101): el enlace expone el saldo y los
// presupuestos, así que lo crea quien ve el estado de cuenta (ADMIN y
// recepción, PAYMENT_ROLES, como el enlace de pago). Ni la URL ni el token
// van a la auditoría.
@ApiTags('patient-access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@ApiParam({ name: 'id', format: 'uuid', description: 'El paciente' })
@ApiForbiddenResponse({ description: 'Rol sin acceso al estado de cuenta' })
@Controller('patients/:id/access-links')
export class PatientAccessLinksController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly createLink: CreateAccessLinkUseCase,
    private readonly listLinks: ListAccessLinksUseCase,
    private readonly revokeLink: RevokeAccessLinkUseCase,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_ACCESS_LINK',
    resourceId: { response: 'id' },
    patient: { param: 'id' },
    reason: PATIENT_ACCESS_LINK_CREATED_REASON,
  })
  @Post()
  @ApiOperation({
    summary: 'Crea el enlace de acceso del paciente (solo lectura)',
    description:
      'DX-101. Apartados elegidos (citas, presupuestos, estado de cuenta) y validez de 1 a 30 días (14 por defecto). Para abrirlo se pide la fecha de nacimiento del paciente. La URL (con el token) solo viene en esta respuesta. `whatsapp` trae el número y el texto para wa.me, sin importes. Auditado como CREATE de PATIENT_ACCESS_LINK.',
  })
  @ApiCreatedResponse({ type: CreatedAccessLinkDto })
  @ApiBadRequestResponse({
    description:
      'Apartados vacíos, repetidos o no válidos, validez fuera de 1–30, o el host no sirve para armar el enlace',
  })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  @ApiConflictResponse({
    description:
      'El paciente no tiene fecha de nacimiento (es el segundo factor) o está archivado',
  })
  create(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateAccessLinkDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedAccessLinkDto> {
    return this.createLink.execute(
      patientId,
      { scopes: dto.scopes, ttlDays: dto.ttlDays },
      req.user.sub,
      { protocol: this.protocol, host: safeLinkHost(req.tenantHost?.host) },
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Enlaces de acceso vivos del paciente',
    description:
      'DX-101. Ni revocados ni caducados, del más reciente al más antiguo (hasta 50), con el último acceso verificado y el bloqueo si lo hay. Sin URL: el token no se guarda.',
  })
  @ApiOkResponse({ type: [AccessLinkDto] })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  list(
    @Param('id', ParseUUIDPipe) patientId: string,
  ): Promise<AccessLinkDto[]> {
    return this.listLinks.execute(patientId);
  }

  @Audit({
    action: 'DELETE',
    resource: 'PATIENT_ACCESS_LINK',
    resourceId: { param: 'linkId' },
    patient: { param: 'id' },
    reason: PATIENT_ACCESS_LINK_REVOKED_REASON,
  })
  @Delete(':linkId')
  @HttpCode(204)
  @ApiParam({ name: 'linkId', format: 'uuid' })
  @ApiOperation({
    summary: 'Revoca el enlace (corta también la sesión abierta)',
    description:
      'DX-101. La siguiente petición del paciente con ese enlace da 410. Revocar uno ya revocado es 204. Auditado como DELETE de PATIENT_ACCESS_LINK.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'Enlace inexistente, de otro paciente o de otra clínica',
  })
  async revoke(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.revokeLink.execute(patientId, linkId, req.user.sub);
  }
}
