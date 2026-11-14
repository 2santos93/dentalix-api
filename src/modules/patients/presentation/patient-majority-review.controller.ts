import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  MAJORITY_REVIEW_ROLES,
  PATIENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetMajorityReviewUseCase,
  ListComingOfAgeUseCase,
  ReviewMajorityUseCase,
  type ComingOfAgeList,
  type MajorityReviewView,
} from '../application/use-cases/majority-review.use-cases';
import {
  ComingOfAgeListDto,
  ComingOfAgeQueryDto,
  MajorityReviewViewDto,
  ReviewMajorityDto,
} from './dto/majority-review.dto';

export const MAJORITY_REVIEW_FORBIDDEN_MESSAGE =
  'Tu rol no puede revisar el paso a la mayoría de edad: lo hacen administración y recepción.';

const uuidPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException('El identificador del paciente no es válido.'),
});

interface ReviewRequest {
  user: TenantJwtPayload;
  /** DX-342: decisión y largo de la nota (nunca su texto) para el evento. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * DX-342: paso a la mayoría de edad con responsable. Un paciente que cumplió
 * la mayoría de edad de la clínica con un responsable dado de alta cuando era
 * menor queda PENDING: sus avisos, recibos y estados de cuenta van a él (o a
 * nadie, sin email) hasta que recepción revise con él a quién tienen que ir.
 *
 * Va ANTES que PatientsController en el módulo: si no, `GET
 * /patients/coming-of-age` caería en `GET /patients/:id` (400 de UUID).
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...MAJORITY_REVIEW_ROLES)
@RolesDeniedMessage(MAJORITY_REVIEW_FORBIDDEN_MESSAGE)
@Controller('patients')
export class PatientMajorityReviewController {
  constructor(
    private readonly listComingOfAge: ListComingOfAgeUseCase,
    private readonly getReview: GetMajorityReviewUseCase,
    private readonly review: ReviewMajorityUseCase,
  ) {}

  @Get('coming-of-age')
  @ApiOperation({
    summary: 'Pacientes que pasan a la mayoría de edad en un período (DX-342)',
    description:
      'Pacientes con responsable cuya fecha de mayoría de edad (nacimiento + mayoría de edad de la clínica) cae en ' +
      '[from, to], más los ya adultos PENDING con la mayoría antes de `from` (`overdue`). ' +
      'Un miembro restringido a unas sedes solo ve a los pacientes de esas sedes (la de su última cita atendida); ' +
      'un paciente sin citas atendidas solo lo ve quien no está restringido. ADMIN y RECEPTION; el resto, 403 en español.',
  })
  @ApiOkResponse({ type: ComingOfAgeListDto })
  @ApiNotFoundResponse({
    description: '`locationId` no es una sede de la clínica',
  })
  @ApiBadRequestResponse({
    description: 'Período no válido o de más de 366 días',
  })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso o sede no permitida (LOCATION_NOT_ALLOWED)',
  })
  list(@Query() query: ComingOfAgeQueryDto): Promise<ComingOfAgeList> {
    return this.listComingOfAge.execute(query);
  }

  @Get(':id/majority-review')
  @Roles(...PATIENT_ROLES)
  @ApiOperation({
    summary: 'Estado del paso a la mayoría de edad del paciente (DX-342)',
    description:
      'Para el aviso y el modal de la ficha. La edad cuenta en el día civil de la sede activa o principal. Lo ven los 4 roles, como los responsables.',
  })
  @ApiOkResponse({ type: MajorityReviewViewDto })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  get(@Param('id', uuidPipe) id: string): Promise<MajorityReviewView> {
    return this.getReview.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'MAJORITY_REVIEWED',
  })
  @Post(':id/majority-review')
  @ApiOperation({
    summary: 'Revisar el paso a la mayoría de edad (DX-342)',
    description:
      'PATIENT_SELF: los envíos van al propio paciente (sin email: a nadie). KEEP_RESPONSIBLE: siguen yendo a su ' +
      'responsable con su consentimiento. Vale para su fecha de mayoría de edad vigente; rige la última. ' +
      'Queda en la auditoría (motivo MAJORITY_REVIEWED) con la decisión y el largo de la nota, nunca su texto.',
  })
  @ApiCreatedResponse({ type: MajorityReviewViewDto })
  @ApiBadRequestResponse({ description: 'Validación (mensaje en español)' })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  @ApiConflictResponse({ description: 'El paciente todavía es menor de edad' })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin fecha de nacimiento, sin responsables o con responsables dados de alta ya adulto',
  })
  async create(
    @Param('id', uuidPipe) id: string,
    @Body() dto: ReviewMajorityDto,
    @Req() req: ReviewRequest,
  ): Promise<MajorityReviewView> {
    const view = await this.review.execute(id, dto, req.user.sub);
    req.auditMetadata = {
      majorityReview: {
        decision: dto.decision,
        noteLength: dto.note?.trim().length ?? 0,
        majorityDate: view.majorityDate,
      },
    };
    return view;
  }
}
