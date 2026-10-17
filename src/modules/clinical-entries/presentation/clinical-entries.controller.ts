import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MethodNotAllowedException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiMethodNotAllowedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';
import { ListClinicalEntriesQueryDto } from './dto/list-clinical-entries-query.dto';
import { CreateClinicalEntryUseCase } from '../application/use-cases/create-clinical-entry.use-case';
import { ListClinicalEntriesUseCase } from '../application/use-cases/list-clinical-entries.use-case';
import { ClinicalEntry } from '../domain/entities/clinical-entry.entity';
import { ClinicalEntryDto } from './dto/clinical-entry.dto';
import { ClinicalEntryAddendumDto } from './dto/clinical-entry-addendum.dto';
import { CreateClinicalEntryAddendumDto } from './dto/create-clinical-entry-addendum.dto';
import { CreateClinicalEntryAddendumUseCase } from '../application/use-cases/create-clinical-entry-addendum.use-case';
import { ListClinicalEntryAddendaUseCase } from '../application/use-cases/list-clinical-entry-addenda.use-case';
import { ClinicalEntryAddendum } from '../domain/entities/clinical-entry-addendum.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/** Respuesta a cualquier intento de editar o borrar una evolución (DX-038). */
export const CLINICAL_ENTRY_IMMUTABLE_MESSAGE =
  'Una evolución de la historia clínica no se puede modificar ni borrar (Res. 1995 de 1999, art. 18). Para corregirla, añade una adenda: POST /patients/{patientId}/clinical-entries/{entryId}/addenda';

// Las evoluciones son INALTERABLES (DX-038): no hay caso de uso ni método de
// repositorio que las edite o borre, y la BD lo impide con un trigger. Las
// rutas PATCH/PUT/DELETE existen solo para responder 405 con un mensaje que
// remite a la adenda, en vez de un 404 genérico.
@ApiTags('clinical-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/clinical-entries')
export class ClinicalEntriesController {
  constructor(
    private readonly createClinicalEntry: CreateClinicalEntryUseCase,
    private readonly listClinicalEntries: ListClinicalEntriesUseCase,
    private readonly createAddendum: CreateClinicalEntryAddendumUseCase,
    private readonly listAddenda: ListClinicalEntryAddendaUseCase,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'CLINICAL_ENTRY',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @ApiOperation({
    summary: 'Registra una evolución (inalterable, DX-038)',
    description:
      'DX-170: con `templateId`, el texto compuesto se guarda en `notes` (enviado ya revisado, o compuesto por el servidor con `answers`). Con `appointmentId`, la evolución queda ligada a la cita.',
  })
  @ApiCreatedResponse({ type: ClinicalEntryDto })
  @ApiBadRequestResponse({
    description:
      'Texto vacío, respuesta inválida, plantilla desactivada, cita de otro paciente, cita cancelada / no-show o cita de un día futuro.',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente, cita o plantilla no encontrados en esta clínica (inexistentes o de otra clínica).',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateClinicalEntryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicalEntry> {
    return this.createClinicalEntry.execute(
      patientId,
      {
        entryDate: dto.entryDate ? new Date(dto.entryDate) : undefined,
        reason: dto.reason,
        notes: dto.notes,
        appointmentId: dto.appointmentId,
        templateId: dto.templateId,
        answers: dto.answers?.map((a) => ({
          promptId: a.promptId,
          values: a.values,
          skipped: a.skipped,
        })),
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOkResponse({ type: [ClinicalEntryDto] })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: ListClinicalEntriesQueryDto,
  ): Promise<ClinicalEntry[]> {
    return this.listClinicalEntries.execute(patientId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'CLINICAL_ENTRY_ADDENDUM',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post(':entryId/addenda')
  @ApiOperation({
    summary: 'Añade una adenda de corrección a una evolución (DX-038)',
    description:
      'La evolución original no cambia. Autor y fecha los pone el servidor.',
  })
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiCreatedResponse({ type: ClinicalEntryAddendumDto })
  @ApiBadRequestResponse({ description: 'Motivo o texto inválidos.' })
  @ApiNotFoundResponse({
    description:
      'Paciente o evolución no encontrados en esta clínica (o la evolución es de otro paciente).',
  })
  addAddendum(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: CreateClinicalEntryAddendumDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicalEntryAddendum> {
    return this.createAddendum.execute(
      patientId,
      entryId,
      { reason: dto.reason, text: dto.text },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'CLINICAL_ENTRY_ADDENDUM',
    resourceId: { param: 'entryId' },
    patient: { param: 'patientId' },
  })
  @Get(':entryId/addenda')
  @ApiOperation({
    summary: 'Adendas de una evolución, en orden cronológico (DX-038)',
  })
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOkResponse({ type: [ClinicalEntryAddendumDto] })
  @ApiNotFoundResponse({
    description: 'Paciente o evolución no encontrados en esta clínica.',
  })
  addenda(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<ClinicalEntryAddendum[]> {
    return this.listAddenda.execute(patientId, entryId);
  }

  @Patch(':entryId')
  @HttpCode(405)
  @ApiOperation({ summary: 'No permitido: una evolución no se edita (DX-038)' })
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiMethodNotAllowedResponse({
    description: CLINICAL_ENTRY_IMMUTABLE_MESSAGE,
  })
  rejectPatch(): never {
    throw new MethodNotAllowedException(CLINICAL_ENTRY_IMMUTABLE_MESSAGE);
  }

  @Put(':entryId')
  @HttpCode(405)
  @ApiOperation({ summary: 'No permitido: una evolución no se edita (DX-038)' })
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiMethodNotAllowedResponse({
    description: CLINICAL_ENTRY_IMMUTABLE_MESSAGE,
  })
  rejectPut(): never {
    throw new MethodNotAllowedException(CLINICAL_ENTRY_IMMUTABLE_MESSAGE);
  }

  @Delete(':entryId')
  @HttpCode(405)
  @ApiOperation({ summary: 'No permitido: una evolución no se borra (DX-038)' })
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiMethodNotAllowedResponse({
    description: CLINICAL_ENTRY_IMMUTABLE_MESSAGE,
  })
  rejectDelete(): never {
    throw new MethodNotAllowedException(CLINICAL_ENTRY_IMMUTABLE_MESSAGE);
  }
}
