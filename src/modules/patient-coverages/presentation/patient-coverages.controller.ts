import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreatePatientCoverageUseCase,
  DeletePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  UpdatePatientCoverageUseCase,
  type PatientCoverageView,
} from '../application/use-cases/patient-coverages.use-cases';
import {
  CreatePatientCoverageDto,
  PatientCoverageDto,
  UpdatePatientCoverageDto,
} from './dto/patient-coverage.dto';

const uuidPipe = (what: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException(`El identificador ${what} no es válido.`),
  });

// Auditoría como DX-203: UPDATE de PATIENT con el motivo; la metadata solo
// lleva los NOMBRES de los campos enviados, nunca el número de afiliado ni el
// titular. El GET no se audita (la ficha ya se audita en `GET /patients/:id`).
const audit = (reason: string) =>
  ({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
    reason,
  }) as const;

/**
 * Bloque «Cobertura» de la ficha (DX-153): con qué pagador, plan y afiliado se
 * atiende el paciente, hasta 5, una principal. Datos administrativos y de
 * cobro, no clínicos: los 4 roles (PATIENT_ROLES, como «Editar» de la ficha).
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients/:patientId/coverages')
export class PatientCoveragesController {
  constructor(
    private readonly listCoverages: ListPatientCoveragesUseCase,
    private readonly createCoverage: CreatePatientCoverageUseCase,
    private readonly updateCoverage: UpdatePatientCoverageUseCase,
    private readonly deleteCoverage: DeletePatientCoverageUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Coberturas del paciente: la principal primero, luego por fecha de alta (DX-153)',
  })
  @ApiOkResponse({ type: PatientCoverageDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  list(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
  ): Promise<PatientCoverageView[]> {
    return this.listCoverages.execute(patientId);
  }

  @Audit(audit('COVERAGE_ADDED'))
  @Post()
  @ApiOperation({
    summary: 'Añadir una cobertura al paciente (DX-153)',
    description:
      'La primera cobertura viva es la principal aunque no se pida. `isPrimary: true` en otra desmarca la anterior.',
  })
  @ApiCreatedResponse({ type: PatientCoverageDto })
  @ApiBadRequestResponse({
    description:
      'Validación, pagador inexistente o desactivado, vigencia inválida o más de 5 coberturas',
  })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  @ApiUnprocessableEntityResponse({
    description: 'Otra petición cambió la cobertura principal a la vez',
  })
  create(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Body() dto: CreatePatientCoverageDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<PatientCoverageView> {
    return this.createCoverage.execute(patientId, dto, req.user.sub);
  }

  @Audit(audit('COVERAGE_CHANGED'))
  @Patch(':coverageId')
  @ApiOperation({
    summary: 'Editar una cobertura; null vacía los campos opcionales (DX-153)',
  })
  @ApiOkResponse({ type: PatientCoverageDto })
  @ApiBadRequestResponse({
    description:
      'Validación, pagador inexistente o desactivado, vigencia inválida o dejar al paciente sin principal',
  })
  @ApiNotFoundResponse({ description: 'Paciente o cobertura no encontrado' })
  @ApiUnprocessableEntityResponse({
    description: 'Otra petición cambió la cobertura principal a la vez',
  })
  update(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Param('coverageId', uuidPipe('de la cobertura')) coverageId: string,
    @Body() dto: UpdatePatientCoverageDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<PatientCoverageView> {
    return this.updateCoverage.execute(
      patientId,
      coverageId,
      dto,
      req.user.sub,
    );
  }

  @Audit(audit('COVERAGE_REMOVED'))
  @Delete(':coverageId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Retirar una cobertura; si era la principal, la más antigua pasa a serlo (DX-153)',
  })
  @ApiNoContentResponse({ description: 'Retirada' })
  @ApiNotFoundResponse({ description: 'Paciente o cobertura no encontrado' })
  async remove(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Param('coverageId', uuidPipe('de la cobertura')) coverageId: string,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<void> {
    await this.deleteCoverage.execute(patientId, coverageId, req.user.sub);
  }
}
