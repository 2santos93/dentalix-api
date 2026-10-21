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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  ANAMNESIS_SETTINGS_WRITE_ROLES,
  APPOINTMENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetAnamnesisSettingsUseCase,
  GetPatientMedicalAlertsUseCase,
  UpdateAnamnesisSettingsUseCase,
  type AnamnesisSettings,
  type PatientMedicalAlertsView,
} from '../application/use-cases/medical-alerts.use-cases';
import {
  AnamnesisSettingsDto,
  PatientMedicalAlertsDto,
} from './dto/medical-alerts.dto';

export const ANAMNESIS_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar la vigencia de la anamnesis.';

/**
 * Banderas médicas de un paciente (DX-247). Las leen los cuatro roles que ven
 * la agenda: recepción también, porque prepara la visita (premedicación). Solo
 * banderas: la historia sigue en `medical-history` (CLINICAL_ROLES).
 */
@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/medical-alerts')
export class PatientMedicalAlertsController {
  constructor(private readonly getAlerts: GetPatientMedicalAlertsUseCase) {}

  @Get()
  @ApiOperation({
    summary:
      'Banderas médicas del paciente (alertas, premedicación, anamnesis al día / caducada / ausente)',
  })
  @ApiOkResponse({ type: PatientMedicalAlertsDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PatientMedicalAlertsView> {
    return this.getAlerts.execute(patientId);
  }
}

/** Vigencia de la anamnesis de la clínica (DX-247). */
@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('medical-history/settings')
export class AnamnesisSettingsController {
  constructor(
    private readonly getSettings: GetAnamnesisSettingsUseCase,
    private readonly updateSettings: UpdateAnamnesisSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Vigencia de la anamnesis de la clínica' })
  @ApiOkResponse({ type: AnamnesisSettingsDto })
  get(): Promise<AnamnesisSettings> {
    return this.getSettings.execute();
  }

  @Put()
  @Roles(...ANAMNESIS_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(ANAMNESIS_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia la vigencia de la anamnesis (1–60 meses); queda en la auditoría',
  })
  @ApiOkResponse({ type: AnamnesisSettingsDto })
  @ApiBadRequestResponse({ description: 'Fuera de 1–60 meses' })
  @ApiForbiddenResponse({ description: ANAMNESIS_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: AnamnesisSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<AnamnesisSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute(
      { anamnesisValidityMonths: dto.anamnesisValidityMonths },
      ctx,
    );
  }
}
