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
import { CLINIC_SETTINGS_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetClinicCurrencyTextsUseCase,
  UpdateClinicCurrencyTextsUseCase,
  type ClinicCurrencyTextsView,
} from '../application/use-cases/clinic-currency-texts.use-cases';
import { ClinicCurrencyTextsDto } from './dto/clinic-currency-texts.dto';

export const CURRENCY_TEXTS_FORBIDDEN_MESSAGE =
  'Solo administración configura cómo se escribe cada moneda.';

/**
 * DX-517: el texto propio de cada moneda de la clínica («VES» → «Bs.»). Solo
 * ADMIN lo edita aquí; cada cambio queda en la auditoría de configuración con
 * su antes y su después. Todos los roles (y las páginas públicas) lo reciben
 * con la marca de la clínica (`GET /public/tenant/branding`), que es lo que
 * usa la web para pintar los importes.
 */
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(CURRENCY_TEXTS_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: CURRENCY_TEXTS_FORBIDDEN_MESSAGE })
@Controller('exchange/currency-texts')
export class ClinicCurrencyTextsController {
  constructor(
    private readonly getTexts: GetClinicCurrencyTextsUseCase,
    private readonly updateTexts: UpdateClinicCurrencyTextsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Texto propio de cada moneda de la clínica (DX-517)',
  })
  @ApiOkResponse({ type: ClinicCurrencyTextsDto })
  texts(): Promise<ClinicCurrencyTextsView> {
    return this.getTexts.execute();
  }

  @Put()
  @ApiOperation({
    summary: 'Cambia el texto propio de las monedas de la clínica',
    description:
      'DX-517. Sustituye la lista entera; vacía = sin textos propios. El ' +
      'texto ocupa el lugar del código ISO en la posición que da el formato ' +
      'de la sede. Queda en la auditoría con el antes y el después. Los ' +
      'recibos ya emitidos conservan su foto.',
  })
  @ApiOkResponse({ type: ClinicCurrencyTextsDto })
  @ApiBadRequestResponse({
    description:
      'Una moneda fuera del catálogo o repetida, un texto vacío, con saltos de línea o de más de 8 caracteres, o más de 30 monedas',
  })
  update(
    @Body() dto: ClinicCurrencyTextsDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicCurrencyTextsView> {
    return this.updateTexts.execute(
      dto.entries,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
