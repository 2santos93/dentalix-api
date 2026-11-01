import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import { CLINIC_SETTINGS_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetReceiptSettingsUseCase,
  UpdateLocationReceiptLegendUseCase,
  UpdateReceiptSettingsUseCase,
  type ReceiptSettingsView,
} from '../application/receipts/receipt-settings.use-cases';
import type { ClinicReceiptSettings } from '../domain/receipt-settings';
import type { LocationReceiptLegendView } from '../domain/ports/receipt-settings-repository.port';
import {
  LocationReceiptLegendDto,
  LocationReceiptLegendViewDto,
  ReceiptSettingsDto,
  ReceiptSettingsViewDto,
} from './dto/receipt-settings.dto';

export const RECEIPT_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo administración configura el título y la leyenda del recibo.';

/**
 * DX-515: título y leyenda del recibo de caja (por clínica; la leyenda, con
 * opción de que cada sede tenga la suya). Solo ADMIN los lee y los cambia;
 * cada cambio queda auditado con su antes y su después en la transacción del
 * cambio (sin evento si nada cambia). Aplican a los recibos que se emitan
 * desde ahora: un recibo emitido conserva su foto.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(RECEIPT_SETTINGS_FORBIDDEN_MESSAGE)
@Controller('payment-receipts/settings')
export class ReceiptSettingsController {
  constructor(
    private readonly getSettings: GetReceiptSettingsUseCase,
    private readonly updateSettings: UpdateReceiptSettingsUseCase,
    private readonly updateLocationLegend: UpdateLocationReceiptLegendUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Título y leyenda del recibo de la clínica y de cada sede (DX-515)',
  })
  @ApiOkResponse({ type: ReceiptSettingsViewDto })
  @ApiForbiddenResponse({ description: RECEIPT_SETTINGS_FORBIDDEN_MESSAGE })
  settings(): Promise<ReceiptSettingsView> {
    return this.getSettings.execute();
  }

  @Put()
  @ApiOperation({
    summary: 'Cambia el título y la leyenda del recibo de la clínica',
    description:
      'DX-515. Vacío o null = sin configurar. Aplica a los recibos que se ' +
      'emitan desde ahora; queda en la auditoría con el antes y el después.',
  })
  @ApiOkResponse({ type: ReceiptSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Un texto que no es texto, con saltos de línea o demasiado largo',
  })
  @ApiForbiddenResponse({ description: RECEIPT_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: ReceiptSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicReceiptSettings> {
    return this.updateSettings.execute(
      { title: dto.title, legend: dto.legend },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Put('locations/:locationId')
  @ApiOperation({
    summary: 'La leyenda propia de una sede (o volver a la de la clínica)',
    description:
      'DX-515. override false = la sede usa la leyenda de la clínica; true ' +
      'con leyenda vacía = la sede no imprime ninguna.',
  })
  @ApiOkResponse({ type: LocationReceiptLegendViewDto })
  @ApiBadRequestResponse({
    description: 'Leyenda con saltos de línea o demasiado larga, o id no UUID',
  })
  @ApiNotFoundResponse({
    description: 'La sede no existe o es de otra clínica',
  })
  @ApiForbiddenResponse({ description: RECEIPT_SETTINGS_FORBIDDEN_MESSAGE })
  updateLocation(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: LocationReceiptLegendDto,
    @Req() req: AuditableRequest,
  ): Promise<LocationReceiptLegendView> {
    return this.updateLocationLegend.execute(
      locationId,
      { override: dto.override, legend: dto.legend },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
