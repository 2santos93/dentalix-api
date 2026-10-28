import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  ApiHeader,
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
  CLINIC_SETTINGS_WRITE_ROLES,
  CLINICAL_ROLES,
  PRESCRIPTION_ISSUE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetPrescriptionSettingsUseCase,
  UpdatePrescriptionSettingsUseCase,
} from '../application/use-cases/prescription-settings.use-cases';
import type { PrescriptionSettings } from '../domain/prescription-settings';
import { PrescriptionSettingsDto } from './dto/prescription-settings.dto';
import {
  CheckPrescriptionSafetyUseCase,
  GetPrescriptionIssuerUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
  ListPatientPrescriptionsUseCase,
  VoidPrescriptionUseCase,
  type PrescriptionIssuerView,
  type PrescriptionSafetyPreview,
} from '../application/use-cases/prescriptions.use-cases';
import {
  IssuePrescriptionDto,
  PrescriptionSafetyCheckDto,
  VoidPrescriptionDto,
} from './dto/issue-prescription.dto';
import {
  PrescriptionDocumentDto,
  PrescriptionDto,
  PrescriptionIssuerDto,
  PrescriptionSafetyPreviewDto,
  SafetyConflictDto,
} from './dto/prescription.dto';
import {
  presentPrescription,
  presentPrescriptionDocument,
} from './prescription.presenter';
import { Audit } from '../../audit/presentation/audit.decorator';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

export const PRESCRIPTION_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de la receta.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede desde la que se emite (da la dirección y la zona horaria). Sin ella, la sede principal.',
};

// Sin @Patch, @Put ni @Delete A PROPÓSITO: una receta emitida es documento
// médico-legal inmutable; solo se ANULA (POST :id/void). El puerto del
// repositorio no tiene update de contenido y un trigger de la base rechaza
// cualquier otro cambio (20261016200000_prescriptions). Recepción no entra.
@ApiTags('prescriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/prescriptions')
export class PatientPrescriptionsController {
  constructor(
    private readonly listPrescriptions: ListPatientPrescriptionsUseCase,
    private readonly issuePrescription: IssuePrescriptionUseCase,
    private readonly checkSafety: CheckPrescriptionSafetyUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'PRESCRIPTION',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOkResponse({
    type: [PrescriptionDto],
    description: 'Más reciente primero; incluye anuladas',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PrescriptionDto[]> {
    const prescriptions = await this.listPrescriptions.execute(patientId);
    return prescriptions.map(presentPrescription);
  }

  /**
   * DX-300: lee la anamnesis vigente del paciente (alergias, medicación,
   * embarazo, peso) para calcular los avisos: queda auditada como lectura de
   * la anamnesis. Declarada antes que cualquier `:id`.
   */
  @Audit({
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: { param: 'patientId' },
    reason: 'PRESCRIPTION_SAFETY_CHECK',
  })
  @Post('safety-check')
  @HttpCode(200)
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({
    type: PrescriptionSafetyPreviewDto,
    description:
      'Avisos de seguridad que daría la emisión con estos medicamentos (alergias con las casillas de la anamnesis, interacciones, embarazo, antirresortivos, dosis infantil por peso, sin anamnesis). Solo una vista previa: no guarda nada y la emisión los vuelve a calcular. Es una ayuda: no sustituye el juicio clínico.',
  })
  @ApiBadRequestResponse({ description: 'Cuerpo inválido (en español)' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Solo DENTIST y ADMIN emiten recetas' })
  safetyCheck(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: PrescriptionSafetyCheckDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PrescriptionSafetyPreview> {
    return this.checkSafety.execute(patientId, dto.items, req.user.sub);
  }

  @Audit({
    action: 'CREATE',
    resource: 'PRESCRIPTION',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    prescriptionSafety: true,
  })
  @Post()
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: PrescriptionDto })
  @ApiBadRequestResponse({
    description:
      'Falta un campo obligatorio de la receta o el documento del paciente si la clínica lo exige (mensaje en español con todos los que faltan), o fecha de inicio inválida',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    type: SafetyConflictDto,
    description:
      'Avisos de seguridad bloqueantes (DX-300: alergia —lista o casillas de la anamnesis—, interacción grave, embarazo, dosis infantil) sin `safetyOverride=true` y `safetyOverrideReason`; mensaje en español con los avisos',
  })
  @ApiForbiddenResponse({ description: 'Solo DENTIST y ADMIN emiten recetas' })
  async issue(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: IssuePrescriptionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PrescriptionDto> {
    const issued = await this.issuePrescription.execute(
      patientId,
      {
        items: dto.items,
        dispensationDate: dto.dispensationDate,
        notes: dto.notes,
        professionalLicense: dto.professionalLicense,
        allergyOverride: dto.allergyOverride,
        safetyOverride: dto.safetyOverride,
        safetyOverrideReason: dto.safetyOverrideReason,
      },
      req.user.sub,
    );
    return presentPrescription(issued);
  }
}

@ApiTags('prescriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(
    private readonly getIssuer: GetPrescriptionIssuerUseCase,
    private readonly getPrescription: GetPrescriptionUseCase,
    private readonly voidPrescription: VoidPrescriptionUseCase,
    private readonly getSettings: GetPrescriptionSettingsUseCase,
    private readonly updateSettings: UpdatePrescriptionSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Declarada ANTES de `:id`: Express casa las rutas en orden.
  @Get('issuer')
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({
    type: PrescriptionIssuerDto,
    description:
      'Sede desde la que se emitiría, registro y especialidad del usuario, y los ajustes de receta de la clínica',
  })
  issuer(@Req() req: AuthenticatedRequest): Promise<PrescriptionIssuerView> {
    return this.getIssuer.execute(req.user.sub);
  }

  // También antes de `:id`: si no, `settings` se leería como el id de una
  // receta.
  @Get('settings')
  @ApiOperation({ summary: 'Ajustes de la receta de la clínica (DX-324)' })
  @ApiOkResponse({ type: PrescriptionSettingsDto })
  settings(): Promise<PrescriptionSettings> {
    return this.getSettings.execute();
  }

  @Put('settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(PRESCRIPTION_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia los ajustes de la receta de la clínica; queda en la auditoría',
    description:
      'DX-324. Aplica a la siguiente emisión; una receta ya emitida no cambia. ' +
      'Si nada cambia, responde 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: PrescriptionSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Falta un campo, un sí/no que no es booleano o una validez fuera de 1–365 o no entera',
  })
  @ApiForbiddenResponse({
    description: PRESCRIPTION_SETTINGS_FORBIDDEN_MESSAGE,
  })
  updateClinicSettings(
    @Body() dto: PrescriptionSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<PrescriptionSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute(
      {
        printQuantityInWords: dto.printQuantityInWords,
        requireClinicalRecordNumber: dto.requireClinicalRecordNumber,
        validityDays: dto.validityDays,
      },
      ctx,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'PRESCRIPTION',
    resourceId: { param: 'id' },
    patient: { lookup: 'prescription', param: 'id' },
  })
  @Get(':id')
  @ApiOkResponse({ type: PrescriptionDocumentDto })
  @ApiNotFoundResponse({ description: 'Receta no encontrada en esta clínica' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PrescriptionDocumentDto> {
    return presentPrescriptionDocument(await this.getPrescription.execute(id));
  }

  @Audit({
    action: 'VOID',
    resource: 'PRESCRIPTION',
    resourceId: { param: 'id' },
    patient: { lookup: 'prescription', param: 'id' },
  })
  @Post(':id/void')
  @HttpCode(200)
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiOkResponse({ type: PrescriptionDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío' })
  @ApiNotFoundResponse({ description: 'Receta no encontrada en esta clínica' })
  @ApiConflictResponse({ description: 'La receta ya está anulada' })
  @ApiForbiddenResponse({
    description:
      'Solo quien la emitió o un ADMIN (y nunca asistente ni recepción)',
  })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPrescriptionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PrescriptionDto> {
    const voided = await this.voidPrescription.execute(id, dto.reason, {
      userId: req.user.sub,
      role: req.user.role,
    });
    return presentPrescription(voided);
  }
}
