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
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetClinicalEntrySettingsUseCase,
  GetClinicalEntrySigningUseCase,
  UpdateClinicalEntrySettingsUseCase,
  type ClinicalEntrySigning,
} from '../application/use-cases/clinical-entry-settings.use-cases';
import type { ClinicalEntrySettings } from '../domain/ports/clinical-entry-settings-repository.port';
import {
  ClinicalEntrySettingsDto,
  ClinicalEntrySigningDto,
} from './dto/clinical-entry-settings.dto';

export const CLINICAL_ENTRY_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de las evoluciones.';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/**
 * DX-540: aviso de registro profesional al firmar una evolución. Ajuste de la
 * clínica (como los de la receta, DX-324): ninguna regla mira el país. Los
 * roles clínicos leen el ajuste y su propia firma; solo ADMIN lo cambia.
 */
@ApiTags('clinical-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('clinical-entries')
export class ClinicalEntrySettingsController {
  constructor(
    private readonly getSigning: GetClinicalEntrySigningUseCase,
    private readonly getSettings: GetClinicalEntrySettingsUseCase,
    private readonly updateSettings: UpdateClinicalEntrySettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('signing')
  @ApiOperation({
    summary:
      'Registro profesional del usuario y aviso que traería su firma (DX-540)',
    description:
      'Para avisar en «Nueva evolución» antes de guardar. Mismo cálculo que el alta.',
  })
  @ApiOkResponse({ type: ClinicalEntrySigningDto })
  signing(@Req() req: AuthenticatedRequest): Promise<ClinicalEntrySigning> {
    return this.getSigning.execute(req.user.sub);
  }

  @Get('settings')
  @ApiOperation({
    summary: 'Ajustes de las evoluciones de la clínica (DX-540)',
  })
  @ApiOkResponse({ type: ClinicalEntrySettingsDto })
  settings(): Promise<ClinicalEntrySettings> {
    return this.getSettings.execute();
  }

  @Put('settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(CLINICAL_ENTRY_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia los ajustes de las evoluciones de la clínica; queda en la auditoría',
    description:
      'DX-540. Aplica a la siguiente firma; una evolución ya firmada no cambia. Si nada cambia, responde 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: ClinicalEntrySettingsDto })
  @ApiBadRequestResponse({ description: 'Falta el sí/no o no es booleano' })
  @ApiForbiddenResponse({
    description: CLINICAL_ENTRY_SETTINGS_FORBIDDEN_MESSAGE,
  })
  update(
    @Body() dto: ClinicalEntrySettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicalEntrySettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute(
      { warnMissingProfessionalLicense: dto.warnMissingProfessionalLicense },
      ctx,
    );
  }
}
