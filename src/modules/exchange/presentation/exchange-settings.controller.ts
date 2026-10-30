import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  CorrectManualExchangeRateUseCase,
  ListManualExchangeRatesUseCase,
  RegisterManualExchangeRateUseCase,
} from '../application/use-cases/manual-exchange-rates.use-cases';
import type { ManualExchangeRate } from '../domain/entities/manual-exchange-rate.entity';
import {
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_IN_USE_MESSAGE,
  MANUAL_RATE_NOT_A_MEMBER_MESSAGE,
  MANUAL_RATE_NOT_FOUND_MESSAGE,
} from '../domain/exchange-rate-source';
import {
  ExchangeRateSettingsDto,
  UpdateExchangeRateSettingsDto,
} from './dto/exchange-rate-settings.dto';
import {
  CorrectManualExchangeRateDto,
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
    private readonly correctManualRate: CorrectManualExchangeRateUseCase,
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
      'DX-374. Pasar a MANUAL fija `manualSince` = hoy en la sede principal: ' +
      'desde ese día la tasa sale de las manuales y los días anteriores siguen ' +
      'con la automática, así que los saldos de antes del cambio no se mueven. ' +
      'Guardar MANUAL otra vez conserva el día. Volver a AUTOMATIC lo limpia: ' +
      'los días del periodo manual vuelven a la tasa automática hasta que cada ' +
      'abono congele su tasa (DX-375). DX-402: con MANUAL, la tasa manual de ' +
      'un día anterior a `manualSince` sirve de tasa de respaldo a los abonos ' +
      'de ese día que siguen sin tasa (si el proveedor no tiene la de ese ' +
      'día). Evento CLINIC_SETTINGS con reason ' +
      'EXCHANGE_RATE_SOURCE y el antes y el después; si la fuente no cambia, ' +
      '200 sin evento.',
  })
  @ApiOkResponse({ type: ExchangeRateSettingsDto })
  @ApiBadRequestResponse({
    description: 'Fuente que no es AUTOMATIC ni MANUAL',
  })
  updateClinicSettings(
    @Body() dto: UpdateExchangeRateSettingsDto,
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
      'clínica es MANUAL, para los días desde `manualSince` (se puede dejar ' +
      'registrada antes de cambiarla). DX-402: la de un día anterior a ' +
      '`manualSince` sirve, con MANUAL, de tasa de respaldo a los abonos de ' +
      'ese día que siguen sin tasa si el proveedor no tiene la de ese día ' +
      '(GET /payments/rate-backlog/day dice cuántos); nunca cambia una tasa ' +
      'ya congelada. Una ' +
      'tasa ya registrada para ese día y moneda no se sobrescribe: si ningún ' +
      'abono la usó, se corrige con PUT /exchange/manual-rates/:id.',
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

  @Audit({
    action: 'UPDATE',
    resource: 'EXCHANGE_RATE',
    resourceId: { param: 'id' },
  })
  @Put('manual-rates/:id')
  @ApiOperation({
    summary:
      'Corrige una tasa manual que ningún abono usó; queda en la auditoría',
    description:
      'DX-375. Solo cambia la tasa (unidades de la moneda por 1 USD); el día ' +
      'y la moneda no. Cada abono congela la tasa con que se convirtió al ' +
      'registrarse, así que una tasa que ya usa algún abono no se cambia: ' +
      '409 MANUAL_EXCHANGE_RATE_IN_USE (también lo impide la BD). Corregir ' +
      'una sin usar sí afecta a los abonos que la congelen después.',
  })
  @ApiOkResponse({ type: ManualExchangeRateDto })
  @ApiBadRequestResponse({
    description: 'Tasa que no es > 0 con hasta 8 decimales',
  })
  @ApiNotFoundResponse({ description: MANUAL_RATE_NOT_FOUND_MESSAGE })
  @ApiConflictResponse({ description: MANUAL_RATE_IN_USE_MESSAGE })
  correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectManualExchangeRateDto,
  ): Promise<ManualExchangeRate> {
    return this.correctManualRate.execute(id, { rate: dto.rate });
  }
}
