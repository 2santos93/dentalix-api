import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';
import { ListClinicalEntriesQueryDto } from './dto/list-clinical-entries-query.dto';
import { CreateClinicalEntryUseCase } from '../application/use-cases/create-clinical-entry.use-case';
import { ListClinicalEntriesUseCase } from '../application/use-cases/list-clinical-entries.use-case';
import { ClinicalEntry } from '../domain/entities/clinical-entry.entity';
import { ClinicalEntryDto } from './dto/clinical-entry.dto';
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

// NOTE: deliberately NO @Patch/@Delete route on this controller — clinical
// entries are immutable evolutions; a correction is always a brand-new
// entry, never an edit of an existing one (see CreateClinicalEntryUseCase /
// ClinicalEntryRepository, which has no update/delete method at all).
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
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'CLINICAL_ENTRY',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @ApiCreatedResponse({ type: ClinicalEntryDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
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
}
