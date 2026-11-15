import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
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
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  ClinicalRecordCopiesUseCases,
  type ClinicalRecordCopyDocument,
} from '../application/clinical-record-copies.use-cases';
import type { ClinicalRecordCopySummary } from '../domain/clinical-record-copy';
import {
  ClinicalRecordCopyDocumentDto,
  ClinicalRecordCopySummaryDto,
  CreateClinicalRecordCopyDto,
} from './dto/clinical-record-copy.dto';

export const CLINICAL_RECORD_COPY_FORBIDDEN_MESSAGE =
  'Solo el personal clínico (odontología, asistencia y administración) puede generar la copia de la historia clínica.';

export const CLINICAL_RECORD_COPY_GENERATED = 'CLINICAL_RECORD_COPY_GENERATED';
export const CLINICAL_RECORD_COPY_PRINTED = 'CLINICAL_RECORD_COPY_PRINTED';
export const CLINICAL_RECORD_COPIES_LISTED = 'CLINICAL_RECORD_COPIES_LISTED';

const NOT_FOUND = 'Paciente o copia no encontrados en esta clínica';

/**
 * DX-456: «Copia de la historia clínica» de la ficha. Solo los roles clínicos
 * y ADMIN, como la historia (`CLINICAL_ROLES`). Sin PATCH ni DELETE: cada
 * generación es un registro de auditoría inalterable.
 */
@ApiTags('clinical-record-copies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@RolesDeniedMessage(CLINICAL_RECORD_COPY_FORBIDDEN_MESSAGE)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/clinical-record-copies')
export class ClinicalRecordCopiesController {
  constructor(
    private readonly copies: ClinicalRecordCopiesUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
    reason: CLINICAL_RECORD_COPIES_LISTED,
  })
  @Get()
  @ApiOperation({
    summary: 'Generaciones anteriores de la copia (más reciente primero)',
    description:
      'Período, secciones, quién la generó, en qué sede y «entregado a». Sin contenido clínico.',
  })
  @ApiOkResponse({ type: [ClinicalRecordCopySummaryDto] })
  @ApiForbiddenResponse({ description: CLINICAL_RECORD_COPY_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<ClinicalRecordCopySummary[]> {
    return this.copies.list(patientId);
  }

  // Auditada por el caso de uso: EXPORT · PATIENT · CLINICAL_RECORD_COPY_GENERATED
  // en la MISMA transacción que la generación (`params.copyId`, `period`,
  // `recordCopy` con los códigos de las secciones; nunca el «entregado a»).
  @Post()
  @ApiOperation({
    summary: 'Generar una copia de la historia clínica',
    description:
      'Período desde/hasta (inclusivos, días civiles de la sede de la petición) y secciones. Deja la generación y un evento EXPORT; devuelve el resumen. El documento se lee con `GET …/:id/document`.',
  })
  @ApiCreatedResponse({ type: ClinicalRecordCopySummaryDto })
  @ApiBadRequestResponse({
    description:
      'Período inválido o que empieza después de hoy, sin secciones, secciones desconocidas o repetidas, o «entregado a» de más de 120 caracteres o con saltos de línea',
  })
  @ApiForbiddenResponse({
    description: `${CLINICAL_RECORD_COPY_FORBIDDEN_MESSAGE} O la sede de la petición no está permitida (LOCATION_NOT_ALLOWED).`,
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiConflictResponse({ description: 'La sede no tiene zona horaria' })
  generate(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateClinicalRecordCopyDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicalRecordCopySummary> {
    return this.copies.generate(
      patientId,
      {
        from: dto.from,
        to: dto.to,
        sections: dto.sections,
        deliveredTo: dto.deliveredTo,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'PRINT',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
    reason: CLINICAL_RECORD_COPY_PRINTED,
  })
  @Get(':copyId/document')
  @ApiOperation({
    summary: 'Documento de una copia generada (vista imprimible)',
    description:
      'Cabecera (clínica, sede, paciente) y las secciones elegidas con lo que cae en el período y estaba registrado al generarla: reimprimir da el mismo documento. Evoluciones con sus adendas en orden; las anuladas no salen, como en la ficha. Sin ids internos. Auditado: PRINT · PATIENT.',
  })
  @ApiParam({ name: 'copyId', format: 'uuid' })
  @ApiOkResponse({ type: ClinicalRecordCopyDocumentDto })
  @ApiForbiddenResponse({
    description: `${CLINICAL_RECORD_COPY_FORBIDDEN_MESSAGE} O la copia es de una sede no permitida (LOCATION_NOT_ALLOWED).`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'La sede no tiene zona horaria' })
  async document(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('copyId', ParseUUIDPipe) copyId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClinicalRecordCopyDocument> {
    const document = await this.copies.document(patientId, copyId);
    // Dato clínico: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return document;
  }
}
