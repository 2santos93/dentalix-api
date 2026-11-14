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
  APPOINTMENT_ROLES,
  CLINIC_SETTINGS_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetSlotOfferSettingsUseCase,
  UpdateSlotOfferSettingsUseCase,
  type SlotOfferSettingsView,
} from '../application/use-cases/slot-offer-settings.use-cases';
import {
  SlotOfferSettingsDto,
  UpdateSlotOfferSettingsDto,
} from './dto/slot-offer-settings.dto';

export const SLOT_OFFER_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de las ofertas de hueco.';

/**
 * Ajustes de la oferta de hueco por enlace (DX-448), de toda la clínica. Ruta
 * propia, sin colgar de `waitlist/` (choca con `waitlist/:id`). Los leen los
 * roles de la agenda; los cambia solo ADMIN, auditado.
 */
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('slot-offer-settings')
export class SlotOfferSettingsController {
  constructor(
    private readonly getSettings: GetSlotOfferSettingsUseCase,
    private readonly updateSettings: UpdateSlotOfferSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Caducidad anticipada y antelación mínima de la oferta de hueco por enlace (DX-448)',
  })
  @ApiOkResponse({ type: SlotOfferSettingsDto })
  settings(): Promise<SlotOfferSettingsView> {
    return this.getSettings.execute();
  }

  @Put()
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(SLOT_OFFER_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia la caducidad anticipada y la antelación mínima de la oferta de hueco; queda en la auditoría (DX-448)',
    description:
      'Aplica a las ofertas que se envíen después; las ya enviadas conservan su caducidad. Si nada cambia, responde 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: SlotOfferSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Falta un valor, o la caducidad no es un entero de 0 a 240 o la antelación mínima de 5 a 240',
  })
  @ApiForbiddenResponse({ description: SLOT_OFFER_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: UpdateSlotOfferSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<SlotOfferSettingsView> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute(
      {
        expiryLeadMinutes: dto.expiryLeadMinutes,
        minLeadMinutes: dto.minLeadMinutes,
      },
      ctx,
    );
  }
}
