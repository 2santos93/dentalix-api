import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
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
import {
  CLINIC_SETTINGS_WRITE_ROLES,
  TREATMENT_PLAN_QUOTE_READ_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetQuoteSettingsUseCase,
  UpdateQuoteSettingsUseCase,
} from '../application/use-cases/quote-settings.use-cases';
import type { QuoteSettings } from '../domain/quote-validity';
import { QuoteSettingsDto } from './dto/quote-settings.dto';

export const QUOTE_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar la validez de los presupuestos.';

/**
 * Ajuste de validez del presupuesto (DX-379, D-12). Ruta propia, sin colgar
 * de `treatment-plans/` (choca con `treatment-plans/:id`). Lo leen los roles
 * que leen presupuestos; lo cambia solo ADMIN, auditado.
 */
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...TREATMENT_PLAN_QUOTE_READ_ROLES)
@Controller('treatment-plan-settings')
export class QuoteSettingsController {
  constructor(
    private readonly getSettings: GetQuoteSettingsUseCase,
    private readonly updateSettings: UpdateQuoteSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Cuántos días vale un presupuesto en la clínica (DX-379)',
  })
  @ApiOkResponse({ type: QuoteSettingsDto })
  settings(): Promise<QuoteSettings> {
    return this.getSettings.execute();
  }

  @Put()
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(QUOTE_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia cuántos días vale un presupuesto; queda en la auditoría (DX-379)',
    description:
      'Aplica a los presupuestos que se emitan después (presentar el plan o imprimirlo por primera vez); los ya emitidos conservan sus fechas. Si nada cambia, responde 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: QuoteSettingsDto })
  @ApiBadRequestResponse({
    description: 'Falta la validez, o no es un entero de 1 a 365',
  })
  @ApiForbiddenResponse({ description: QUOTE_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: QuoteSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<QuoteSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute({ validityDays: dto.validityDays }, ctx);
  }
}
