import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  PatientDataConsentsDto,
  RecordDataConsentsDto,
} from './dto/data-consent.dto';
import { GetPatientDataConsentsUseCase } from '../application/use-cases/get-patient-data-consents.use-case';
import { RecordDataConsentsUseCase } from '../application/use-cases/record-data-consents.use-case';
import type { PatientDataConsents } from '../domain/entities/data-consent.entity';
import { consentEvidenceFrom, EvidenceRequest } from './consent-evidence';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { DATA_CONSENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

type AuthenticatedRequest = EvidenceRequest & { user: JwtPayload };

// Append-only: solo GET y POST. Revocar es un POST con `granted: false`; no
// existe ruta de edición ni de borrado (y la BD rechaza UPDATE/DELETE).
@ApiTags('data-consents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...DATA_CONSENT_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/data-consents')
export class PatientDataConsentsController {
  constructor(
    private readonly getConsents: GetPatientDataConsentsUseCase,
    private readonly recordConsents: RecordDataConsentsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Autorizaciones de datos del paciente: estado vigente por scope e historial',
  })
  @ApiOkResponse({ type: PatientDataConsentsDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PatientDataConsents> {
    return this.getConsents.execute(patientId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar aceptaciones o revocaciones (una fila por decisión)',
    description:
      'Guarda versión de política, scope, canal IN_PERSON, quién lo registra, hora del servidor, IP y user-agent. Devuelve el estado resultante.',
  })
  @ApiCreatedResponse({ type: PatientDataConsentsDto })
  @ApiBadRequestResponse({
    description: 'Sin decisiones, scope repetido o datos inválidos.',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  @ApiConflictResponse({
    description:
      'La clínica no tiene política publicada o `policyVersionId` no es la vigente.',
  })
  record(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RecordDataConsentsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientDataConsents> {
    return this.recordConsents.execute(
      patientId,
      { policyVersionId: dto.policyVersionId, decisions: dto.decisions },
      req.user.sub,
      consentEvidenceFrom(req),
    );
  }
}
