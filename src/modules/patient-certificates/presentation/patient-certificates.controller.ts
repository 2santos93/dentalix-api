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
  Res,
  StreamableFile,
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
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  CERTIFICATE_ROLES,
  CLINIC_SETTINGS_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  CertificateSettingsUseCases,
  PatientCertificatesUseCases,
} from '../application/patient-certificates.use-cases';
import type { CertificateSettings } from '../domain/ports/patient-certificate-repository.port';
import { SendCertificateCopyUseCase } from '../application/certificate-copies.use-cases';
import { CERTIFICATE_COPY_SENT_REASON } from '../domain/certificate-copy-link';
import {
  CertificateCopySentDto,
  CertificateIssuerDto,
  CertificateSettingsDto,
  EligibleAppointmentDto,
  IssueCertificateDto,
  PatientCertificateDto,
  VoidCertificateDto,
} from './dto/patient-certificate.dto';
import {
  presentCertificate,
  presentCopySent,
  presentEligibleAppointment,
} from './patient-certificate.presenter';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const actorOf = (req: AuthenticatedRequest) => ({
  userId: req.user.sub,
  role: req.user.role,
});

export const CERTIFICATE_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de los certificados.';

const ISSUED = 'CERTIFICATE_ISSUED';
const VOIDED = 'CERTIFICATE_VOIDED';
const NOT_FOUND = 'Paciente o certificado no encontrado en esta clínica';
const PDF_SCHEMA = { type: 'string', format: 'binary' } as const;

/**
 * DX-306: justificantes de asistencia y certificados de reposo de la ficha.
 * Sin PATCH ni DELETE A PROPÓSITO: un certificado emitido es inalterable (lo
 * protege un trigger) y solo se ANULA con motivo. Auditoría:
 * CREATE · CERTIFICATE_ISSUED y VOID · CERTIFICATE_VOIDED, sin el diagnóstico.
 */
@ApiTags('patient-certificates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CERTIFICATE_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/certificates')
export class PatientCertificatesController {
  constructor(
    private readonly certificates: PatientCertificatesUseCases,
    private readonly sendCopy: SendCertificateCopyUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_CERTIFICATE',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Certificados del paciente (más reciente primero, con anulados)',
    description:
      'El diagnóstico de un reposo solo sale para los roles clínicos y quien lo emitió; recepción recibe `diagnosis: null` y `hasDiagnosis`.',
  })
  @ApiOkResponse({ type: [PatientCertificateDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientCertificateDto[]> {
    const list = await this.certificates.list(patientId, actorOf(req));
    return list.map(presentCertificate);
  }

  // Antes de `:id`: Express casa las rutas en orden.
  @Get('appointments')
  @ApiOperation({
    summary: 'Citas atendidas del paciente que admiten certificado',
    description:
      'Las 30 más recientes en COMPLETED de las sedes permitidas al usuario, con los tipos que ya tienen un certificado vigente.',
  })
  @ApiOkResponse({ type: [EligibleAppointmentDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  async appointments(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<EligibleAppointmentDto[]> {
    const rows = await this.certificates.eligibleAppointments(patientId);
    return rows.map(presentEligibleAppointment);
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason: ISSUED,
  })
  @Post()
  @ApiOperation({
    summary: 'Emitir un justificante de asistencia o un certificado de reposo',
    description:
      'De una cita ATENDIDA de una sede permitida. Guarda la foto de paciente, profesional, sede y clínica, el número de la sede y archiva el PDF en los documentos del paciente (REPORT). Justificante: horas reales de llegada y salida o, sin ellas, las programadas. Reposo: DENTIST o ADMIN con registro profesional, días entre 1 y el máximo de la clínica, inicio no anterior a la atención, diagnóstico solo si la clínica lo imprime. Auditado: CREATE · PATIENT_CERTIFICATE · CERTIFICATE_ISSUED (sin diagnóstico).',
  })
  @ApiCreatedResponse({ type: PatientCertificateDto })
  @ApiBadRequestResponse({
    description:
      'Cuerpo inválido, o reposo con algo que falta o sobra (mensaje en español que dice qué: registro profesional, días, fecha de inicio, diagnóstico)',
  })
  @ApiForbiddenResponse({
    description:
      'Reposo pedido por un rol que no lo emite, o la sede de la cita no está permitida (LOCATION_NOT_ALLOWED)',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente o cita no encontrados (o de otro paciente o clínica)',
  })
  @ApiConflictResponse({
    description:
      'La cita no está atendida, ya hay uno vigente de ese tipo para la cita, o la sede no tiene zona o formato regional',
  })
  async issue(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: IssueCertificateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientCertificateDto> {
    const certificate = await this.certificates.issue(
      patientId,
      {
        kind: dto.kind,
        appointmentId: dto.appointmentId,
        restDays: dto.restDays,
        restStartDate: dto.restStartDate,
        diagnosis: dto.diagnosis,
      },
      actorOf(req),
    );
    return presentCertificate(certificate);
  }

  @Audit({
    action: 'PRINT',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Get(':id/pdf')
  @ApiOperation({
    summary: 'PDF del certificado (generado ahora desde su foto)',
    description:
      'Fechas y horas en la zona, el locale y el reloj de la sede. Un anulado sale con «ANULADO». Auditado: PRINT · PATIENT_CERTIFICATE.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (inline).', schema: PDF_SCHEMA })
  @ApiForbiddenResponse({
    description:
      'Sede no permitida, o un reposo con diagnóstico pedido por recepción',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async pdf(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.certificates.pdf(patientId, id, actorOf(req));
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      contentDispositionHeader({
        disposition: 'inline',
        filename: result.fileName,
      }),
    );
    res.set('Cache-Control', 'private, no-store');
    return new StreamableFile(result.pdf);
  }

  @Audit({
    action: 'VOID',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: VOIDED,
  })
  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anular un certificado con motivo',
    description:
      'Quien lo emitió o un ADMIN. No se borra: queda anulado, el PDF archivado se anula en la ficha y se archiva el PDF con «ANULADO». Auditado: VOID · PATIENT_CERTIFICATE · CERTIFICATE_VOIDED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PatientCertificateDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o demasiado largo' })
  @ApiForbiddenResponse({
    description: 'No lo emitió ni es ADMIN, o la sede no está permitida',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'Ya está anulado' })
  async void(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidCertificateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientCertificateDto> {
    return presentCertificate(
      await this.certificates.void(patientId, id, dto.reason, actorOf(req)),
    );
  }

  @Audit({
    action: 'SEND',
    resource: 'PATIENT_CERTIFICATE',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: CERTIFICATE_COPY_SENT_REASON,
  })
  @Post(':id/patient-copy')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Enviar por WhatsApp una copia del certificado al paciente',
    description:
      'Crea un enlace caducable (30 días por defecto; se guarda solo el hash del token) a la copia de un certificado VIGENTE; el enlace anterior deja de servir en la misma transacción. Devuelve el número, el enlace y el texto (clínica y enlace, nada clínico) para que la web abra wa.me. Un menor la recibe por su responsable que recibe avisos. Auditado: SEND · PATIENT_CERTIFICATE · CERTIFICATE_COPY_SENT.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CertificateCopySentDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiForbiddenResponse({
    description:
      'La sede no está permitida, o un reposo con diagnóstico enviado por recepción',
  })
  @ApiConflictResponse({
    description:
      'El certificado está anulado, el paciente está archivado, la sede no tiene zona o formato, o no se pudo armar el enlace de la clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin a quién enviarlo: sin teléfono para WhatsApp, baja de los envíos, o un menor sin responsable con teléfono',
  })
  async sendPatientCopy(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest & TenantHostRequest,
  ): Promise<CertificateCopySentDto> {
    return presentCopySent(
      await this.sendCopy.execute(
        patientId,
        id,
        actorOf(req),
        req.tenantHost?.host,
      ),
    );
  }
}

/** DX-306: ajustes de los certificados de la clínica y el perfil de quien emite. */
@ApiTags('patient-certificates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CERTIFICATE_ROLES)
@Controller('certificates')
export class CertificateSettingsController {
  constructor(
    private readonly settings: CertificateSettingsUseCases,
    private readonly certificates: PatientCertificatesUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('issuer')
  @ApiOperation({
    summary:
      'Qué certificados puede emitir el usuario y su registro profesional',
  })
  @ApiOkResponse({ type: CertificateIssuerDto })
  issuer(@Req() req: AuthenticatedRequest): Promise<CertificateIssuerDto> {
    return this.certificates.issuer(actorOf(req));
  }

  @Get('settings')
  @ApiOperation({ summary: 'Ajustes de los certificados de la clínica' })
  @ApiOkResponse({ type: CertificateSettingsDto })
  get(): Promise<CertificateSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(CERTIFICATE_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Cambia los ajustes de los certificados; queda en la auditoría',
    description:
      'Máximo de días de reposo (1–365) y si el reposo imprime el diagnóstico. Aplica a la siguiente emisión. Si nada cambia, 200 sin evento (UPDATE · CLINIC_SETTINGS · CERTIFICATE_SETTINGS).',
  })
  @ApiOkResponse({ type: CertificateSettingsDto })
  @ApiBadRequestResponse({
    description: 'Días fuera de 1–365 o sí/no inválido',
  })
  @ApiForbiddenResponse({ description: CERTIFICATE_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: CertificateSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<CertificateSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.settings.update(
      {
        restMaxDays: dto.restMaxDays,
        restPrintDiagnosis: dto.restPrintDiagnosis,
      },
      ctx,
    );
  }
}
