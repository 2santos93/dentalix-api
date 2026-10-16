import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CreateToothRecordDto } from './dto/create-tooth-record.dto';
import { AddToothRecordUseCase } from '../application/use-cases/add-tooth-record.use-case';
import {
  GetOdontogramUseCase,
  OdontogramToothGroup,
} from '../application/use-cases/get-odontogram.use-case';
import {
  GetToothTimelineUseCase,
  ToothTimelineEntry,
} from '../application/use-cases/get-tooth-timeline.use-case';
import {
  DentitionView,
  GetDentitionUseCase,
  RecordDentitionEventsUseCase,
} from '../application/use-cases/dentition.use-cases';
import { VoidToothRecordUseCase } from '../application/use-cases/void-tooth-record.use-case';
import { ToothRecord } from '../domain/entities/tooth-record.entity';
import type { DentitionEvent } from '../domain/dentition';
import { ToothRecordDto, ToothTimelineEntryDto } from './dto/tooth-record.dto';
import { VoidToothRecordDto } from './dto/void-tooth-record.dto';
import {
  AsOfQueryDto,
  DentitionDto,
  DentitionEventDto,
  RecordDentitionEventsDto,
} from './dto/dentition.dto';
import { OdontogramGroupDto } from './dto/odontogram-group.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

// NOTE: deliberately NO @Patch/@Delete route on this controller — ToothRecord
// is an immutable clinical event; a correction is always a brand-new record,
// never an edit of an existing one (see AddToothRecordUseCase /
// ToothRecordRepository, which has no update/delete method at all). DX-120:
// a mistake is VOIDED (POST tooth-records/:recordId/void), which inserts yet
// another record; the database rejects any UPDATE/DELETE with a trigger.
@ApiTags('odontogram')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId')
export class OdontogramController {
  constructor(
    private readonly addToothRecord: AddToothRecordUseCase,
    private readonly getOdontogram: GetOdontogramUseCase,
    private readonly getToothTimeline: GetToothTimelineUseCase,
    private readonly getDentition: GetDentitionUseCase,
    private readonly recordDentitionEvents: RecordDentitionEventsUseCase,
    private readonly voidToothRecord: VoidToothRecordUseCase,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'ODONTOGRAM',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post('tooth-records')
  @ApiCreatedResponse({ type: ToothRecordDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'DX-120: el diente no corresponde a la dentición de su posición (temporal en permanente o al revés).',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateToothRecordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ToothRecord> {
    return this.addToothRecord.execute(
      patientId,
      {
        toothNumber: dto.toothNumber,
        surfaces: dto.surfaces,
        kind: dto.kind,
        catalogItemId: dto.catalogItemId,
        status: dto.status,
        notes: dto.notes,
        clinicalEntryId: dto.clinicalEntryId,
        origin: dto.origin,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VOID',
    resource: 'ODONTOGRAM',
    resourceId: { param: 'recordId' },
    patient: { param: 'patientId' },
  })
  @Post('tooth-records/:recordId/void')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anula un registro del odontograma con motivo (DX-120)',
    description:
      'Inserta un registro de anulación; el original no cambia. Deja de pintarse en la carta y queda tachado en el historial. Solo el autor del registro o un ADMIN.',
  })
  @ApiParam({ name: 'recordId', format: 'uuid' })
  @ApiOkResponse({ type: ToothRecordDto, description: 'La anulación creada' })
  @ApiBadRequestResponse({ description: 'Motivo vacío o demasiado largo.' })
  @ApiForbiddenResponse({
    description: 'Ni autor del registro ni ADMIN (o rol sin acceso clínico).',
  })
  @ApiNotFoundResponse({
    description: 'Paciente o registro no encontrados en esta clínica.',
  })
  @ApiConflictResponse({ description: 'El registro ya está anulado.' })
  @ApiUnprocessableEntityResponse({
    description: 'El registro es una anulación: no se anula.',
  })
  void(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: VoidToothRecordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ToothRecord> {
    return this.voidToothRecord.execute(patientId, recordId, dto.reason, {
      userId: req.user.sub,
      role: req.user.role,
    });
  }

  @Audit({
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: { param: 'patientId' },
  })
  @Get('dentition')
  @ApiOperation({
    summary: 'Dentición de cada posición (DX-120)',
    description:
      'Último evento de cada posición o, sin eventos, la que toca por la edad (< 6 años temporal, 6-12 mixta según la tabla de erupción, > 12 permanente). No escribe nada.',
  })
  @ApiOkResponse({ type: DentitionDto })
  @ApiBadRequestResponse({ description: 'asOf inválido o futuro.' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica.',
  })
  dentition(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: AsOfQueryDto,
  ): Promise<DentitionView> {
    return this.getDentition.execute(patientId, query.asOf);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ODONTOGRAM',
    patient: { param: 'patientId' },
    reason: 'DENTITION_CHANGED',
  })
  @Post('dentition-events')
  @ApiOperation({
    summary: 'Cambia la dentición de una o varias posiciones (DX-120)',
    description:
      'Un evento append-only por posición (erupción, exfoliación o cambio manual), todos en una transacción.',
  })
  @ApiCreatedResponse({ type: [DentitionEventDto] })
  @ApiBadRequestResponse({
    description: 'Posiciones, dentición o motivo inválidos.',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Mixta o exfoliación en un molar sin temporal, o exfoliación que no deja la posición en permanente.',
  })
  recordDentition(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RecordDentitionEventsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentitionEvent[]> {
    return this.recordDentitionEvents.execute(
      patientId,
      {
        positions: dto.positions,
        dentition: dto.dentition,
        reason: dto.reason,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: { param: 'patientId' },
  })
  @Get('odontogram')
  @ApiOperation({
    summary: 'Proyección del odontograma',
    description:
      'Registros vigentes por diente (sin los anulados). Con asOf, la carta al final de ese día: lo anulado después sigue y lo posterior no aparece.',
  })
  @ApiOkResponse({ type: [OdontogramGroupDto] })
  @ApiBadRequestResponse({ description: 'asOf inválido o futuro.' })
  projection(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: AsOfQueryDto,
  ): Promise<OdontogramToothGroup[]> {
    return this.getOdontogram.execute(patientId, query.asOf);
  }

  @Audit({
    action: 'VIEW',
    resource: 'ODONTOGRAM',
    patient: { param: 'patientId' },
  })
  @Get('teeth/:fdi/history')
  @ApiOkResponse({
    type: [ToothTimelineEntryDto],
    description: 'Más reciente primero; incluye los anulados, con su anulación',
  })
  history(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('fdi') fdi: string,
  ): Promise<ToothTimelineEntry[]> {
    return this.getToothTimeline.execute(patientId, fdi);
  }
}
