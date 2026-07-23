import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { CreatePatientUseCase } from '../application/use-cases/create-patient.use-case';
import {
  ListPatientsUseCase,
  ListPatientsOutput,
} from '../application/use-cases/list-patients.use-case';
import { GetPatientUseCase } from '../application/use-cases/get-patient.use-case';
import { UpdatePatientUseCase } from '../application/use-cases/update-patient.use-case';
import { Patient } from '../domain/entities/patient.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients')
export class PatientsController {
  constructor(
    private readonly createPatient: CreatePatientUseCase,
    private readonly listPatients: ListPatientsUseCase,
    private readonly getPatient: GetPatientUseCase,
    private readonly updatePatient: UpdatePatientUseCase,
  ) {}

  @Post()
  create(
    @Body() dto: CreatePatientDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient> {
    return this.createPatient.execute({
      ...dto,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      createdById: req.user.sub,
    });
  }

  @Get()
  list(@Query() query: ListPatientsQueryDto): Promise<ListPatientsOutput> {
    return this.listPatients.execute({
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Patient> {
    return this.getPatient.execute(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ): Promise<Patient> {
    return this.updatePatient.execute(id, {
      ...dto,
      birthDate:
        dto.birthDate !== undefined ? new Date(dto.birthDate) : undefined,
    });
  }
}
