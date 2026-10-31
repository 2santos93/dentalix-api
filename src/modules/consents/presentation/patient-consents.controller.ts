import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  SIGNATURE_REQUEST_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { RetrySignedConsentPdfUseCase } from '../application/signed-consent-pdf.service';
import { ResendSignedPdfCopyUseCase } from '../application/signed-pdf-copy.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
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
  SignedConsentPdfRetryDto,
  SignedPdfCopyResentDto,
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
    private readonly retrySignedPdf: RetrySignedConsentPdfUseCase,
    private readonly resendCopy: ResendSignedPdfCopyUseCase,
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

  // DX-422: «Reintentar» el PDF firmado cuando la cola agotó los intentos.
  // Los cuatro roles, como el bloque de firma a distancia de la ficha (no
  // devuelve nada clínico).
  @Audit({
    action: 'UPDATE',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: 'SIGNED_PDF_RETRY',
  })
  @Roles(...SIGNATURE_REQUEST_ROLES)
  @Post(':id/signed-pdf/retry')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: SignedConsentPdfRetryDto })
  // B4: la de la clase («recepción») no aplica aquí: recepción sí reintenta.
  @ApiForbiddenResponse({
    description:
      'Sin un rol de esta clínica (los cuatro roles pueden reintentar)',
  })
  @ApiNotFoundResponse({ description: 'Consentimiento no encontrado' })
  @ApiConflictResponse({
    description: 'El PDF firmado ya está archivado o se está generando',
  })
  retrySignedPdfGeneration(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SignedConsentPdfRetryDto> {
    return this.retrySignedPdf.execute(patientId, id);
  }

  // DX-443: «Reenviar copia» del PDF firmado al paciente (o a su
  // responsable): enlace nuevo de un solo uso y el anterior deja de servir.
  // Los cuatro roles, como el bloque de firma a distancia de la ficha.
  @Audit({
    action: 'SEND',
    resource: 'CONSENT',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: 'SIGNED_PDF_COPY_RESENT',
  })
  @Roles(...SIGNATURE_REQUEST_ROLES)
  @Post(':id/signed-pdf/copy')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reenviar la copia del PDF firmado al paciente',
    description:
      'Envía por email (outbox de DX-088, sin nada clínico) un enlace NUEVO de un solo uso para descargar el PDF firmado, al email de la firma a distancia; el anterior deja de servir en la misma transacción. Auditado como SEND de CONSENT, reason SIGNED_PDF_COPY_RESENT. Sin el token ni la URL en la respuesta.',
  })
  @ApiOkResponse({ type: SignedPdfCopyResentDto })
  @ApiForbiddenResponse({
    description:
      'Sin un rol de esta clínica (los cuatro roles pueden reenviar)',
  })
  @ApiNotFoundResponse({ description: 'Consentimiento no encontrado' })
  @ApiConflictResponse({
    description:
      'El PDF firmado todavía no está archivado, o no se pudo armar el enlace de la clínica',
  })
  @ApiTooManyRequestsResponse({
    description: 'Tope de emails a esta persona o de la clínica',
  })
  resendSignedPdfCopy(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest & TenantHostRequest,
  ): Promise<SignedPdfCopyResentDto> {
    return this.resendCopy.execute(
      patientId,
      id,
      req.user.sub,
      req.tenantHost?.host,
    );
  }
}
