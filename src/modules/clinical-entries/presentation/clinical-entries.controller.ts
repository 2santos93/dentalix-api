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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';
import { ListClinicalEntriesQueryDto } from './dto/list-clinical-entries-query.dto';
import { CreateClinicalEntryUseCase } from '../application/use-cases/create-clinical-entry.use-case';
import { ListClinicalEntriesUseCase } from '../application/use-cases/list-clinical-entries.use-case';
import { ClinicalEntry } from '../domain/entities/clinical-entry.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

const MANAGE_CLINICAL_ENTRIES_ROLES = [
  ClinicRole.OWNER,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

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
@Roles(...MANAGE_CLINICAL_ENTRIES_ROLES)
@Controller('patients/:patientId/clinical-entries')
export class ClinicalEntriesController {
  constructor(
    private readonly createClinicalEntry: CreateClinicalEntryUseCase,
    private readonly listClinicalEntries: ListClinicalEntriesUseCase,
  ) {}

  @Post()
  create(
    @Param('patientId') patientId: string,
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

  @Get()
  list(
    @Param('patientId') patientId: string,
    @Query() query: ListClinicalEntriesQueryDto,
  ): Promise<ClinicalEntry[]> {
    return this.listClinicalEntries.execute(patientId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }
}
