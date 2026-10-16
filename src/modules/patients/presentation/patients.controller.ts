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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { PatientDto } from './dto/patient.dto';
import { ListPatientsResponseDto } from './dto/list-patients-response.dto';
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
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  consentEvidenceFrom,
  EvidenceRequest,
} from '../../data-consents/presentation/consent-evidence';

// RolesGuard (a nivel de clase) ya rechazó cualquier token sin rol de clínica
// (los de plataforma), así que aquí `user` es siempre un token de clínica.
type AuthenticatedRequest = EvidenceRequest & { user: TenantJwtPayload };

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
  @ApiOperation({
    summary: 'Crear paciente (con anamnesis v1 opcional)',
    description:
      '`medicalHistory` crea la versión 1 de la historia clínica y solo lo ' +
      'pueden enviar los roles clínicos (DENTIST, ASSISTANT, ADMIN). ' +
      'RECEPTION crea el paciente sin ese campo; si lo envía, 403.',
  })
  @ApiCreatedResponse({ type: PatientDto })
  @ApiForbiddenResponse({
    description:
      'Rol sin acceso a pacientes, o rol no clínico (RECEPTION) enviando ' +
      '`medicalHistory`',
  })
  create(
    @Body() dto: CreatePatientDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient> {
    return this.createPatient.execute({
      ...dto,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      consentEvidence: consentEvidenceFrom(req),
      createdById: req.user.sub,
      actorRole: req.user.role,
    });
  }

  @Get()
  @ApiOkResponse({ type: ListPatientsResponseDto })
  list(@Query() query: ListPatientsQueryDto): Promise<ListPatientsOutput> {
    return this.listPatients.execute({
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: PatientDto })
  get(@Param('id') id: string): Promise<Patient> {
    return this.getPatient.execute(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: PatientDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ): Promise<Patient> {
    return this.updatePatient.execute(id, {
      ...dto,
      // Tres casos, no dos: ausente = no tocar, `null` = vaciar la columna
      // (es nullable), y una fecha = parsearla. El guard anterior sólo miraba
      // `undefined`, así que un `null` caía en `new Date(null)` y escribía
      // 1970-01-01 en vez de vaciar.
      birthDate:
        dto.birthDate === undefined || dto.birthDate === null
          ? dto.birthDate
          : new Date(dto.birthDate),
    });
  }
}
