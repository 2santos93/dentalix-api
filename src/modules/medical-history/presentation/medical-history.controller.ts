import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SaveMedicalHistoryDto } from './dto/save-medical-history.dto';
import { GetMedicalHistoryUseCase } from '../application/use-cases/get-medical-history.use-case';
import { SaveMedicalHistoryUseCase } from '../application/use-cases/save-medical-history.use-case';
import { MedicalHistory } from '../domain/entities/medical-history.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('patients/:patientId/medical-history')
export class MedicalHistoryController {
  constructor(
    private readonly getMedicalHistory: GetMedicalHistoryUseCase,
    private readonly saveMedicalHistory: SaveMedicalHistoryUseCase,
  ) {}

  // Returns the latest version, or `null` when the patient has none yet —
  // NEVER a 404: an absent anamnesis is a normal state (first visit), not an
  // error (see GetMedicalHistoryUseCase).
  @Get()
  get(@Param('patientId') patientId: string): Promise<MedicalHistory | null> {
    return this.getMedicalHistory.execute(patientId);
  }

  // Always APPENDS a new version; never updates the previous one.
  @Put()
  save(
    @Param('patientId') patientId: string,
    @Body() dto: SaveMedicalHistoryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MedicalHistory> {
    return this.saveMedicalHistory.execute(patientId, dto, req.user.sub);
  }
}
