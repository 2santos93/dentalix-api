import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SaveMedicalHistoryDto } from './dto/save-medical-history.dto';
import { GetMedicalHistoryUseCase } from '../application/use-cases/get-medical-history.use-case';
import { SaveMedicalHistoryUseCase } from '../application/use-cases/save-medical-history.use-case';
import { MedicalHistory } from '../domain/entities/medical-history.entity';
import { MedicalHistoryDto } from './dto/medical-history.dto';
import { AnamnesisConfirmationDto } from './dto/medical-alerts.dto';
import { ConfirmAnamnesisNoChangesUseCase } from '../application/use-cases/medical-alerts.use-cases';
import type { AnamnesisConfirmation } from '../domain/ports/medical-alerts-repository.port';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';

interface AuthenticatedRequest {
  user: JwtPayload;
}

@ApiTags('medical-history')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/medical-history')
export class MedicalHistoryController {
  constructor(
    private readonly getMedicalHistory: GetMedicalHistoryUseCase,
    private readonly saveMedicalHistory: SaveMedicalHistoryUseCase,
    private readonly confirmNoChanges: ConfirmAnamnesisNoChangesUseCase,
  ) {}

  // Returns the latest version, or `null` when the patient has none yet —
  // NEVER a 404: an absent anamnesis is a normal state (first visit), not an
  // error (see GetMedicalHistoryUseCase).
  @Audit({
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiExtraModels(MedicalHistoryDto)
  @ApiOkResponse({
    // Nullable at the SCHEMA level (not just prose) so `openapi-typescript`
    // generates `MedicalHistoryDto | null` for the web client — the handler
    // genuinely returns 200 + null on a first visit (see below).
    schema: {
      oneOf: [{ $ref: getSchemaPath(MedicalHistoryDto) }, { type: 'null' }],
    },
    description:
      'Latest medical history version. Response body is null when the patient does not have one yet (first visit) — this is never a 404.',
  })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<MedicalHistory | null> {
    return this.getMedicalHistory.execute(patientId);
  }

  // Always APPENDS a new version; never updates the previous one.
  @Audit({
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Put()
  @ApiOkResponse({ type: MedicalHistoryDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  save(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: SaveMedicalHistoryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MedicalHistory> {
    return this.saveMedicalHistory.execute(patientId, dto, req.user.sub);
  }

  // DX-247 «Sin cambios hoy»: el paciente dice que nada cambió desde la
  // versión vigente. Guarda quién y cuándo (reloj del servidor) y reinicia la
  // vigencia; no crea una versión. El evento lleva el autor, el paciente y el
  // id de la confirmación, nunca contenido clínico.
  @Audit({
    action: 'UPDATE',
    resource: 'MEDICAL_HISTORY',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason: 'NO_CHANGES_CONFIRMED',
  })
  @Post('no-changes')
  @ApiCreatedResponse({
    type: AnamnesisConfirmationDto,
    description:
      'Confirmación «Sin cambios hoy» sobre la versión vigente: autor, sede y hora del servidor. Queda en la auditoría (`NO_CHANGES_CONFIRMED`).',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  @ApiConflictResponse({
    description: 'El paciente no tiene anamnesis que confirmar.',
  })
  @ApiForbiddenResponse({
    description:
      'Solo DENTIST, ASSISTANT y ADMIN (los que ven la anamnesis); recepción recibe 403.',
  })
  confirm(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnamnesisConfirmation> {
    return this.confirmNoChanges.execute(patientId, req.user.sub);
  }
}
