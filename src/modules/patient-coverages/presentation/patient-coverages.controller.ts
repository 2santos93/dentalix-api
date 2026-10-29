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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  COVERAGE_VERIFY_ROLES,
  PATIENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { COVERAGE_VERIFY_ADMIN_ONLY_MESSAGE } from '../domain/coverage-rules';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { AuditOptions } from '../../audit/presentation/audit-options';
import {
  CreatePatientCoverageUseCase,
  DeletePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  UpdatePatientCoverageUseCase,
  VerifyPatientCoverageUseCase,
  type PatientCoverageView,
} from '../application/use-cases/patient-coverages.use-cases';
import {
  CreatePatientCoverageDto,
  PatientCoverageDto,
  UpdatePatientCoverageDto,
  VerifyPatientCoverageDto,
} from './dto/patient-coverage.dto';

const uuidPipe = (what: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException(`El identificador ${what} no es válido.`),
  });

// Auditoría como DX-203: UPDATE de PATIENT con el motivo; la metadata solo
// lleva los NOMBRES de los campos enviados, nunca el número de afiliado ni el
// titular. El GET no se audita (la ficha ya se audita en `GET /patients/:id`).
// SEC-049: el alta, el cambio y la verificación llevan además el tipo de
// pagador, los 4 últimos del nº y si quedó verificada; el rol de quien lo hizo
// va en el evento (`actorRole`).
const audit = (reason: string, coverage = false): AuditOptions => ({
  action: 'UPDATE',
  resource: 'PATIENT',
  resourceId: { param: 'patientId' },
  patient: { param: 'patientId' },
  reason,
  ...(coverage ? { coverage: true } : {}),
});

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
    private readonly verifyCoverage: VerifyPatientCoverageUseCase,
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

  @Audit(audit('COVERAGE_CREATED', true))
  @Post()
  @ApiOperation({
    summary: 'Añadir una cobertura al paciente (DX-153)',
    description:
      'La primera cobertura viva es la principal aunque no se pida. `isPrimary: true` en otra desmarca la anterior. SEC-049: con un pagador externo el nº de afiliado es obligatorio; la cobertura queda declarada por quien la crea y sin verificar.',
  })
  @ApiCreatedResponse({ type: PatientCoverageDto })
  @ApiBadRequestResponse({
    description:
      'Validación, pagador inexistente o desactivado, vigencia inválida, nº de afiliado ausente o sin formato con un pagador externo, o más de 5 coberturas',
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

  @Audit(audit('COVERAGE_CHANGED', true))
  @Patch(':coverageId')
  @ApiOperation({
    summary: 'Editar una cobertura; null vacía los campos opcionales (DX-153)',
    description:
      'SEC-049: cambiar el pagador o el nº de afiliado borra la verificación y deja la cobertura declarada por quien la edita.',
  })
  @ApiOkResponse({ type: PatientCoverageDto })
  @ApiBadRequestResponse({
    description:
      'Validación, pagador inexistente o desactivado, vigencia inválida, nº de afiliado ausente o sin formato con un pagador externo, o dejar al paciente sin principal',
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

  @Audit(audit('COVERAGE_VERIFIED', true))
  @Post(':coverageId/verification')
  @HttpCode(200)
  @Roles(...COVERAGE_VERIFY_ROLES)
  @RolesDeniedMessage(COVERAGE_VERIFY_ADMIN_ONLY_MESSAGE)
  @ApiOperation({
    summary:
      'Verificar el nº de afiliado de una cobertura de un pagador externo; solo ADMIN (SEC-049)',
    description:
      'Marca quién y cuándo. Con ella verificada, cualquier rol puede asignar el convenio de ese pagador con esta cobertura. Volver a verificar actualiza quién y cuándo.',
  })
  @ApiOkResponse({ type: PatientCoverageDto })
  @ApiBadRequestResponse({
    description:
      'Validación, cobertura sin nº de afiliado o de un pagador interno (OTHER)',
  })
  @ApiForbiddenResponse({ description: 'Solo un administrador' })
  @ApiNotFoundResponse({ description: 'Paciente o cobertura no encontrado' })
  @ApiConflictResponse({
    description:
      'El pagador o el nº de afiliado cambió mientras el administrador lo revisaba',
  })
  verify(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Param('coverageId', uuidPipe('de la cobertura')) coverageId: string,
    @Body() dto: VerifyPatientCoverageDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<PatientCoverageView> {
    return this.verifyCoverage.execute(
      patientId,
      coverageId,
      dto.checkedMemberNumber,
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
