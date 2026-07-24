import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateToothRecordDto } from './dto/create-tooth-record.dto';
import { AddToothRecordUseCase } from '../application/use-cases/add-tooth-record.use-case';
import {
  GetOdontogramUseCase,
  OdontogramToothGroup,
} from '../application/use-cases/get-odontogram.use-case';
import { GetToothTimelineUseCase } from '../application/use-cases/get-tooth-timeline.use-case';
import { ToothRecord } from '../domain/entities/tooth-record.entity';
import { ToothRecordDto } from './dto/tooth-record.dto';
import { OdontogramGroupDto } from './dto/odontogram-group.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// NOTE: deliberately NO @Patch/@Delete route on this controller — ToothRecord
// is an immutable clinical event; a correction is always a brand-new record,
// never an edit of an existing one (see AddToothRecordUseCase /
// ToothRecordRepository, which has no update/delete method at all).
@ApiTags('odontogram')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('patients/:patientId')
export class OdontogramController {
  constructor(
    private readonly addToothRecord: AddToothRecordUseCase,
    private readonly getOdontogram: GetOdontogramUseCase,
    private readonly getToothTimeline: GetToothTimelineUseCase,
  ) {}

  @Post('tooth-records')
  @ApiCreatedResponse({ type: ToothRecordDto })
  create(
    @Param('patientId') patientId: string,
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
      },
      req.user.sub,
    );
  }

  @Get('odontogram')
  @ApiOkResponse({ type: [OdontogramGroupDto] })
  projection(
    @Param('patientId') patientId: string,
  ): Promise<OdontogramToothGroup[]> {
    return this.getOdontogram.execute(patientId);
  }

  @Get('teeth/:fdi/history')
  @ApiOkResponse({ type: [ToothRecordDto] })
  history(
    @Param('patientId') patientId: string,
    @Param('fdi') fdi: string,
  ): Promise<ToothRecord[]> {
    return this.getToothTimeline.execute(patientId, fdi);
  }
}
