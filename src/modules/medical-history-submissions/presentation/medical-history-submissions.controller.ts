import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { MedicalHistorySubmissionStatus } from '@prisma/client';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  ANAMNESIS_REQUEST_ROLES,
  ANAMNESIS_REVIEW_DECISION_ROLES,
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { RevokeAnamnesisRequestUseCase } from '../application/use-cases/anamnesis-requests.use-cases';
import {
  ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE,
  AcceptAnamnesisUseCase,
  CountAnamnesisInboxUseCase,
  GetAnamnesisReviewUseCase,
  ListAnamnesisInboxUseCase,
  RejectAnamnesisUseCase,
} from '../application/use-cases/anamnesis-review.use-cases';
import {
  AcceptAnamnesisDto,
  AnamnesisInboxQueryDto,
  AnamnesisInboxSummaryDto,
  AnamnesisReviewDto,
  AnamnesisSubmissionSummaryDto,
  RejectAnamnesisDto,
} from './dto/anamnesis-requests.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const SUBMISSION = { lookup: 'medicalHistorySubmission', param: 'id' } as const;

// Bandeja «Anamnesis por revisar» y revisión (DX-099). Ver las respuestas:
// CLINICAL_ROLES. Aceptar y rechazar: ADMIN y DENTIST (403 en español al
// resto). Anular un enlace sin usar: los cuatro roles. Todo acotado a las
// sedes del miembro (SEC-045): la bandeja lista solo las suyas y un envío de
// otra sede es 403.
@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('medical-history/submissions')
export class MedicalHistorySubmissionsController {
  constructor(
    private readonly inbox: ListAnamnesisInboxUseCase,
    private readonly count: CountAnamnesisInboxUseCase,
    private readonly review: GetAnamnesisReviewUseCase,
    private readonly acceptSubmission: AcceptAnamnesisUseCase,
    private readonly rejectSubmission: RejectAnamnesisUseCase,
    private readonly revokeRequest: RevokeAnamnesisRequestUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Bandeja de anamnesis (por defecto, las que están por revisar)',
  })
  @ApiOkResponse({ type: [AnamnesisSubmissionSummaryDto] })
  list(
    @Query() query: AnamnesisInboxQueryDto,
  ): Promise<AnamnesisSubmissionSummaryDto[]> {
    return this.inbox.execute(
      query.status ?? MedicalHistorySubmissionStatus.SUBMITTED,
    );
  }

  @Get('summary')
  @ApiOperation({ summary: 'Contador del menú: anamnesis por revisar' })
  @ApiOkResponse({ type: AnamnesisInboxSummaryDto })
  summary(): Promise<AnamnesisInboxSummaryDto> {
    return this.count.execute();
  }

  @Audit({
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: SUBMISSION,
  })
  @Get(':id')
  @ApiOperation({
    summary: 'Revisión: respuestas, versión vigente y diferencias',
  })
  @ApiOkResponse({ type: AnamnesisReviewDto })
  @ApiNotFoundResponse({ description: 'Anamnesis no encontrada' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AnamnesisReviewDto> {
    return this.review.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: SUBMISSION,
    reason: 'ANAMNESIS_ACCEPTED',
  })
  @Roles(...ANAMNESIS_REVIEW_DECISION_ROLES)
  @RolesDeniedMessage(ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE)
  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aceptar: crea una versión de la HC (origen formulario del paciente)',
    description:
      'En una transacción: una versión nueva con source=PATIENT_FORM y autor = quien revisa (banderas recalculadas), y el envío pasa a ACCEPTED. Con `medicalHistory`, guarda esos ajustes en vez de la propuesta.',
  })
  @ApiOkResponse({ type: AnamnesisSubmissionSummaryDto })
  @ApiForbiddenResponse({ description: ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({ description: 'Anamnesis no encontrada' })
  @ApiConflictResponse({ description: 'Ya revisada o aún sin enviar' })
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptAnamnesisDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnamnesisSubmissionSummaryDto> {
    return this.acceptSubmission.execute(id, req.user.sub, dto.medicalHistory);
  }

  // El motivo no va a la auditoría (texto libre): queda en el envío.
  @Audit({
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: SUBMISSION,
    reason: 'ANAMNESIS_REJECTED',
  })
  @Roles(...ANAMNESIS_REVIEW_DECISION_ROLES)
  @RolesDeniedMessage(ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE)
  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar con motivo (la HC no cambia)' })
  @ApiOkResponse({ type: AnamnesisSubmissionSummaryDto })
  @ApiForbiddenResponse({ description: ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({ description: 'Anamnesis no encontrada' })
  @ApiConflictResponse({ description: 'Ya revisada o aún sin enviar' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectAnamnesisDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnamnesisSubmissionSummaryDto> {
    return this.rejectSubmission.execute(id, req.user.sub, dto.reason);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY_SUBMISSION',
    resourceId: { param: 'id' },
    patient: SUBMISSION,
    reason: 'ANAMNESIS_LINK_REVOKED',
  })
  @Roles(...ANAMNESIS_REQUEST_ROLES)
  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Anular un enlace que aún espera al paciente' })
  @ApiOkResponse({ type: AnamnesisSubmissionSummaryDto })
  @ApiNotFoundResponse({ description: 'Anamnesis no encontrada' })
  @ApiConflictResponse({ description: 'El enlace ya no espera respuesta' })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AnamnesisSubmissionSummaryDto> {
    return this.revokeRequest.execute(id);
  }
}
