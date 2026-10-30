import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { EXCHANGE_RATE_SETTINGS_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetExchangeRateSettingsUseCase,
  UpdateExchangeRateSettingsUseCase,
  type ExchangeRateSettings,
} from '../application/use-cases/exchange-rate-settings.use-cases';
import {
  ListManualExchangeRatesUseCase,
  RegisterManualExchangeRateUseCase,
} from '../application/use-cases/manual-exchange-rates.use-cases';
import type { ManualExchangeRate } from '../domain/entities/manual-exchange-rate.entity';
import {
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_NOT_A_MEMBER_MESSAGE,
} from '../domain/exchange-rate-source';
import { ExchangeRateSettingsDto } from './dto/exchange-rate-settings.dto';
import {
  ListManualExchangeRatesQueryDto,
  ManualExchangeRateDto,
  RegisterManualExchangeRateDto,
} from './dto/manual-exchange-rate.dto';

export const EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver y cambiar la tasa de cambio de la clínica.';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

/**
 * Tasa de cambio de la clínica (DX-374): de dónde sale (proveedor o manual) y
 * las tasas manuales. Todo solo ADMIN e igual en todas las sedes; la sede
 * activa solo decide qué día es «hoy» al registrar una tasa.
 */
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_SETTINGS_ROLES)
@RolesDeniedMessage(EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE })
@Controller('exchange')
export class ExchangeSettingsController {
  constructor(
    private readonly getSettings: GetExchangeRateSettingsUseCase,
    private readonly updateSettings: UpdateExchangeRateSettingsUseCase,
    private readonly listManualRates: ListManualExchangeRatesUseCase,
    private readonly registerManualRate: RegisterManualExchangeRateUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary: 'Fuente de la tasa de cambio de la clínica (DX-374)',
  })
  @ApiOkResponse({ type: ExchangeRateSettingsDto })
  settings(): Promise<ExchangeRateSettings> {
    return this.getSettings.execute();
  }

  @Put('settings')
  @ApiOperation({
    summary:
      'Cambia la fuente de la tasa de cambio de la clínica; queda en la auditoría',
    description:
      'DX-374. Aplica desde la siguiente lectura de tasas (saldos, totales, ' +
      'conversiones); los abonos ya cobrados no cambian. Evento ' +
      'CLINIC_SETTINGS con reason EXCHANGE_RATE_SOURCE y el antes y el ' +
      'después. Si nada cambia, 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: ExchangeRateSettingsDto })
  @ApiBadRequestResponse({
    description: 'Fuente que no es AUTOMATIC ni MANUAL',
  })
  updateClinicSettings(
    @Body() dto: ExchangeRateSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ExchangeRateSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute({ source: dto.source }, ctx);
  }

  @Get('manual-rates')
  @ApiOperation({
    summary: 'Últimas tasas de cambio manuales de la clínica (DX-374)',
    description:
      'Del día más reciente al más antiguo y, dentro del día, por moneda.',
  })
  @ApiOkResponse({ type: [ManualExchangeRateDto] })
  manualRates(
    @Query() query: ListManualExchangeRatesQueryDto,
  ): Promise<ManualExchangeRate[]> {
    return this.listManualRates.execute({ limit: query.limit });
  }

  @Audit({
    action: 'CREATE',
    resource: 'EXCHANGE_RATE',
    resourceId: { response: 'id' },
  })
  @Post('manual-rates')
  @ApiOperation({
    summary:
      'Registra la tasa de cambio de un día y una moneda; queda en la auditoría',
    description:
      'DX-374. Unidades de la moneda por 1 USD. Se usa cuando la fuente de la ' +
      'clínica es MANUAL (se puede dejar registrada antes de cambiarla). Una ' +
      'tasa ya registrada para ese día y moneda no se sobrescribe.',
  })
  @ApiCreatedResponse({ type: ManualExchangeRateDto })
  @ApiBadRequestResponse({
    description:
      'Tasa que no es > 0 con hasta 8 decimales, moneda fuera de la lista o USD, o fecha inválida o futura en la zona de la sede',
  })
  @ApiConflictResponse({ description: MANUAL_RATE_DUPLICATE_MESSAGE })
  @ApiForbiddenResponse({ description: MANUAL_RATE_NOT_A_MEMBER_MESSAGE })
  register(
    @Body() dto: RegisterManualExchangeRateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ManualExchangeRate> {
    return this.registerManualRate.execute(
      { date: dto.date, currency: dto.currency, rate: dto.rate },
      req.user.sub,
    );
  }
}
