import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Res,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import { CONTINGENCY_AGENDA_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  CONTINGENCY_FORBIDDEN_MESSAGE,
  ContingencyAgendaUseCases,
  type ContingencyPdf,
  type NightlyInfo,
} from '../application/contingency-agenda.use-cases';
import { ContingencyNightlyInfoDto } from './dto/contingency-agenda.dto';

const CONTENT =
  'Citas de HOY y MAÑANA de la sede (días civiles en su zona IANA; horas en su zona, locale y reloj), sin canceladas ni inasistencias: ' +
  'hora, paciente, teléfono (formato internacional con la región de la sede), profesional, tipo de cita y alertas no clínicas ' +
  '(confirmada o no, en la clínica/atendida, primera visita, pidió que le llamen y «Alerta médica: ver ficha» como sí/no). ' +
  'Nunca notas ni motivo de la cita ni nada de la historia clínica. A4 apaisado.';
const PDF_SCHEMA = { type: 'string', format: 'binary' } as const;
const FORBIDDEN = `${CONTINGENCY_FORBIDDEN_MESSAGE} / sede fuera de las permitidas al usuario (DX-089, code LOCATION_NOT_ALLOWED)`;
const NOT_FOUND =
  'La sede no existe en esta clínica (otra clínica, retirada o desactivada)';
const LOCATION_PARAM = {
  name: 'locationId',
  format: 'uuid',
  description: 'Sede de la clínica.',
} as const;

function sendPdf(res: Response, result: ContingencyPdf): StreamableFile {
  res.set('Content-Type', 'application/pdf');
  res.set(
    'Content-Disposition',
    contentDispositionHeader({
      disposition: 'attachment',
      filename: result.fileName,
    }),
  );
  res.set('Cache-Control', 'private, no-store');
  return new StreamableFile(result.pdf);
}

/**
 * Agenda de contingencia por sede (DX-339): el PDF para trabajar en papel si
 * cae la nube o internet. Cada descarga queda en `audit_events` (EXPORT de
 * LOCATION con la sede como recurso y el motivo).
 */
@ApiTags('contingency-agenda')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CONTINGENCY_AGENDA_ROLES)
@RolesDeniedMessage(CONTINGENCY_FORBIDDEN_MESSAGE)
@Controller('locations/:locationId/contingency-agenda')
export class ContingencyAgendaController {
  constructor(
    private readonly contingency: ContingencyAgendaUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'EXPORT',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CONTINGENCY_AGENDA_DOWNLOADED',
  })
  @Get()
  @ApiOperation({
    summary:
      'Descargar la agenda de contingencia de la sede, generada ahora (PDF)',
    description: `${CONTENT} Auditado: EXPORT · LOCATION · CONTINGENCY_AGENDA_DOWNLOADED.`,
  })
  @ApiParam(LOCATION_PARAM)
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (attachment).', schema: PDF_SCHEMA })
  @ApiBadRequestResponse({ description: 'locationId no es un uuid' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description:
      'La sede no tiene zona horaria válida (LOCATION_TIMEZONE_REQUIRED) o formato regional y reloj (LOCATION_LOCALE_REQUIRED)',
  })
  async download(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.contingency.downloadNow(
      locationId,
      this.tenantContext.getAllowedLocationIds(),
    );
    return sendPdf(res, result);
  }

  @Get('nightly')
  @ApiOperation({
    summary: 'Estado de la copia nocturna de la sede',
    description:
      'Cada noche, desde las 02:00 en la zona de la sede, se genera y guarda su agenda de contingencia (hoy y mañana); se conserva solo la última. ' +
      'Dice si hay copia, de qué día y cuándo se generó; sin datos de pacientes (no se audita).',
  })
  @ApiParam(LOCATION_PARAM)
  @ApiOkResponse({ type: ContingencyNightlyInfoDto })
  @ApiBadRequestResponse({ description: 'locationId no es un uuid' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  nightly(
    @Param('locationId', ParseUUIDPipe) locationId: string,
  ): Promise<NightlyInfo> {
    return this.contingency.nightlyInfo(
      locationId,
      this.tenantContext.getAllowedLocationIds(),
    );
  }

  @Audit({
    action: 'EXPORT',
    resource: 'LOCATION',
    resourceId: { param: 'locationId' },
    reason: 'CONTINGENCY_AGENDA_NIGHTLY_DOWNLOADED',
  })
  @Get('nightly/pdf')
  @ApiOperation({
    summary: 'Descargar la copia nocturna de la agenda de contingencia (PDF)',
    description: `La última copia guardada, tal cual se generó (puede ser de un día anterior: ver GET …/nightly). ${CONTENT} Auditado: EXPORT · LOCATION · CONTINGENCY_AGENDA_NIGHTLY_DOWNLOADED.`,
  })
  @ApiParam(LOCATION_PARAM)
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (attachment).', schema: PDF_SCHEMA })
  @ApiBadRequestResponse({ description: 'locationId no es un uuid' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}, o la sede aún no tiene copia nocturna`,
  })
  async downloadNightly(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.contingency.downloadNightly(
      locationId,
      this.tenantContext.getAllowedLocationIds(),
    );
    return sendPdf(res, result);
  }
}
