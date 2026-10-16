import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  CreatePerioExamUseCase,
  DeletePerioExamUseCase,
  FinalizePerioExamUseCase,
  GetPerioExamUseCase,
  ListPerioExamsUseCase,
  SavePerioMeasuresUseCase,
} from '../application/use-cases/perio-exams.use-cases';
import type {
  PerioExamDetail,
  PerioExamSummary,
} from '../domain/entities/perio-exam.entity';
import { CreatePerioExamDto } from './dto/create-perio-exam.dto';
import { PerioExamDetailDto, PerioExamSummaryDto } from './dto/perio-exam.dto';
import { SavePerioMeasuresDto } from './dto/save-perio-measures.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const NOT_FOUND = 'Paciente o examen no encontrado en esta clínica';
const FINAL = 'El examen está finalizado (inmutable)';

// Periodontograma (DX-007). Dato clínico: CLINICAL_ROLES (recepción 403),
// igual que el odontograma. Un examen FINAL es inmutable: PUT/finalize/DELETE
// dan 409 y una corrección es un examen nuevo.
@ApiTags('perio-exams')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('patients/:patientId/perio-exams')
export class PerioExamsController {
  constructor(
    private readonly listExams: ListPerioExamsUseCase,
    private readonly createExam: CreatePerioExamUseCase,
    private readonly getExam: GetPerioExamUseCase,
    private readonly saveMeasures: SavePerioMeasuresUseCase,
    private readonly finalizeExam: FinalizePerioExamUseCase,
    private readonly deleteExam: DeletePerioExamUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [PerioExamSummaryDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PerioExamSummary[]> {
    return this.listExams.execute(patientId);
  }

  @Post()
  @ApiCreatedResponse({ type: PerioExamDetailDto })
  @ApiBadRequestResponse({ description: 'Fecha inválida o futura' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePerioExamDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PerioExamDetail> {
    return this.createExam.execute(
      patientId,
      {
        examDate: dto.examDate,
        notes: dto.notes,
        copySkippedFromLast: dto.copySkippedFromLast,
      },
      req.user.sub,
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PerioExamDetail> {
    return this.getExam.execute(patientId, id);
  }

  @Put(':id/measures')
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiBadRequestResponse({
    description: 'Valores fuera de rango, FDI o sitio inválidos, duplicados',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: FINAL })
  save(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePerioMeasuresDto,
  ): Promise<PerioExamDetail> {
    return this.saveMeasures.execute(patientId, id, {
      sites: dto.sites.map((s) => ({
        toothFdi: s.toothFdi,
        site: s.site,
        probingMm: s.probingMm ?? null,
        recessionMm: s.recessionMm ?? null,
        furcation: s.furcation ?? null,
        bleeding: s.bleeding ?? false,
        suppuration: s.suppuration ?? false,
        plaque: s.plaque ?? false,
        calculus: s.calculus ?? false,
      })),
      teeth: dto.teeth.map((t) => ({
        toothFdi: t.toothFdi,
        mobility: t.mobility ?? null,
        skipped: t.skipped ?? false,
      })),
      notes: dto.notes,
    });
  }

  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'El examen ya estaba finalizado' })
  finalize(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PerioExamDetail> {
    return this.finalizeExam.execute(patientId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Borrador eliminado' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: FINAL })
  remove(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteExam.execute(patientId, id);
  }
}
