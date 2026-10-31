import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  CountersignPatientConsentUseCase,
  GetPatientConsentUseCase,
  ListPatientConsentsUseCase,
  PreviewPatientConsentUseCase,
  SignPatientConsentUseCase,
  type ConsentPreview,
} from '../application/use-cases/patient-consents.use-cases';
import {
  PatientConsent,
  PatientConsentDocument,
  PatientConsentSummary,
} from '../domain/entities/patient-consent.entity';
import {
  ConsentPreviewDto,
  PatientConsentDocumentDto,
  PatientConsentDto,
  PatientConsentSummaryDto,
} from './dto/patient-consent.dto';
import { PreviewPatientConsentQueryDto } from './dto/preview-patient-consent-query.dto';
import {
  CountersignPatientConsentDto,
  SignPatientConsentDto,
} from './dto/sign-patient-consent.dto';
import { Audit } from '../../audit/presentation/audit.decorator';

type AuthenticatedRequest = Request & { user: JwtPayload };

const USER_AGENT_MAX = 512;

function toDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

/**
 * La respuesta nunca devuelve IP ni UA (quedan para auditoría en la base) y
 * entrega las firmas como data URL, listas para un `<img>`.
 */
function toConsentDto(consent: PatientConsent): PatientConsentDto {
  const { ipAddress: _ip, userAgent: _ua, ...rest } = consent;
  return {
    ...rest,
    patientSignature: toDataUrl(consent.patientSignature),
    professionalSignature: consent.professionalSignature
      ? toDataUrl(consent.professionalSignature)
      : null,
  };
}

// Sin @Patch ni @Delete A PROPÓSITO: un consentimiento firmado es documento
// médico-legal inmutable. Ni el puerto del repositorio tiene esos métodos, y
// un trigger de la base rechaza UPDATE y DELETE
// (20261016180000_patient_consents). Recepción no entra (CLINICAL_ROLES).
@ApiTags('patient-consents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('patients/:patientId/consents')
export class PatientConsentsController {
  constructor(
    private readonly listConsents: ListPatientConsentsUseCase,
    private readonly previewConsent: PreviewPatientConsentUseCase,
    private readonly signConsent: SignPatientConsentUseCase,
    private readonly getConsent: GetPatientConsentUseCase,
    private readonly countersignConsent: CountersignPatientConsentUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'CONSENT',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOkResponse({ type: [PatientConsentSummaryDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PatientConsentSummary[]> {
    return this.listConsents.execute(patientId);
  }

  // Declarada ANTES de `:id`: Express casa las rutas en orden.
  @Audit({
    action: 'VIEW',
    resource: 'CONSENT',
    patient: { param: 'patientId' },
  })
  @Get('preview')
  @ApiOkResponse({ type: ConsentPreviewDto })
  @ApiNotFoundResponse({
    description: 'Paciente, plantilla o plan no encontrados en esta clínica',
  })
  @ApiBadRequestResponse({ description: 'Plantilla desactivada' })
  preview(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: PreviewPatientConsentQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConsentPreview> {
    return this.previewConsent.execute(
      patientId,
      { templateId: query.templateId, treatmentPlanId: query.treatmentPlanId },
      req.user.sub,
    );
  }

  @Audit({
    action: 'SIGN',
    resource: 'CONSENT',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @ApiCreatedResponse({ type: PatientConsentDto })
  @ApiBadRequestResponse({
    description:
      'Falta una firma, no es PNG, supera 200 KB, o falta el tutor; plantilla desactivada',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, plantilla o plan no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description: 'La plantilla cambió desde la vista previa (templateVersion)',
  })
  async sign(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: SignPatientConsentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientConsentDto> {
    const userAgent = req.get('user-agent');
    const consent = await this.signConsent.execute(
      patientId,
      {
        templateId: dto.templateId,
        templateVersion: dto.templateVersion,
        treatmentPlanId: dto.treatmentPlanId,
        signerType: dto.signerType,
        guardianName: dto.guardianName,
        guardianDocument: dto.guardianDocument,
        patientSignature: dto.patientSignature,
        professionalSignature: dto.professionalSignature,
      },
      {
        recordedById: req.user.sub,
        ipAddress: req.ip ?? null,
        userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
      },
    );
    return toConsentDto(consent);
  }

  // DX-243: el profesional firma en la app uno que el paciente firmó a
  // distancia. Append-only: un INSERT en su propia tabla.
  @Audit({
    action: 'SIGN',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: 'CONSENT_COUNTERSIGNED',
  })
  @Post(':id/countersign')
  @ApiCreatedResponse({ type: PatientConsentSummaryDto })
  @ApiBadRequestResponse({
    description: 'Falta la firma, no es PNG o supera 200 KB',
  })
  @ApiForbiddenResponse({
    description:
      'Solo el profesional que se eligió al enviarlo a firmar (y que nombra el texto)',
  })
  @ApiNotFoundResponse({ description: 'Consentimiento no encontrado' })
  @ApiConflictResponse({
    description:
      'Se firmó en la clínica (ya lleva la firma del profesional) o el profesional ya firmó',
  })
  countersign(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CountersignPatientConsentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientConsentSummary> {
    const userAgent = req.get('user-agent');
    return this.countersignConsent.execute(
      patientId,
      id,
      { professionalSignature: dto.professionalSignature },
      {
        recordedById: req.user.sub,
        ipAddress: req.ip ?? null,
        userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
      },
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Get(':id')
  @ApiOkResponse({ type: PatientConsentDocumentDto })
  @ApiNotFoundResponse({ description: 'Consentimiento no encontrado' })
  async get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientConsentDocumentDto> {
    const doc: PatientConsentDocument = await this.getConsent.execute(
      patientId,
      id,
    );
    return {
      ...toConsentDto(doc),
      clinic: doc.clinic,
      patient: doc.patient,
      integrityOk: doc.integrityOk,
      // DX-243: la IP del paciente a distancia es evidencia de la firma y se
      // ve en el documento; la de una firma en pantalla es la de la clínica.
      remoteIpAddress: doc.remote ? doc.ipAddress : null,
    };
  }
}
