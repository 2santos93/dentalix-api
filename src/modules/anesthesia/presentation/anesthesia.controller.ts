import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MethodNotAllowedException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiMethodNotAllowedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  ANESTHESIA_WRITE_ROLES,
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  AnesthesiaUseCases,
  type AnesthesiaCheckResult,
  type RecordedAnesthesia,
} from '../application/use-cases/anesthesia.use-cases';
import type { AnesthesiaAdministration } from '../domain/entities';
import {
  AnesthesiaAdministrationDto,
  AnesthesiaCheckDto,
  AnesthesiaConflictDto,
  AnesthesiaDoseCheckDto,
  EntryAnesthesiaDto,
  RecordAnesthesiaDto,
  RecordedAnesthesiaDto,
} from './dto/anesthesia.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/** Respuesta a cualquier intento de editar o borrar una anestesia (DX-038). */
export const ANESTHESIA_IMMUTABLE_MESSAGE =
  'La anestesia registrada no se puede modificar. Añade una adenda a la evolución.';

const ENTRY = 'patients/:patientId/clinical-entries/:entryId/anesthesia';

// Anestesia local en la evolución (DX-307). Inalterable como la evolución
// (DX-038): PATCH/PUT/DELETE existen solo para responder 405 con un mensaje
// que remite a la adenda.
@ApiTags('anesthesia')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller()
export class AnesthesiaController {
  constructor(private readonly anesthesia: AnesthesiaUseCases) {}

  @Audit({
    action: 'VIEW',
    resource: 'ANESTHESIA_ADMINISTRATION',
    patient: { param: 'patientId' },
  })
  @Get('patients/:patientId/anesthesia')
  @Roles(...CLINICAL_ROLES)
  @ApiOperation({
    summary: 'Anestesia registrada en las evoluciones del paciente (ficha)',
  })
  @ApiOkResponse({ type: [AnesthesiaAdministrationDto] })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  listByPatient(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<AnesthesiaAdministration[]> {
    return this.anesthesia.listByPatient(patientId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'ANESTHESIA_ADMINISTRATION',
    resourceId: { param: 'entryId' },
    patient: { param: 'patientId' },
  })
  @Get(ENTRY)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary:
      'Anestesia de una evolución y el acumulado del paciente en las últimas 24 h frente al máximo',
    description:
      'DX-418: el acumulado suma TODAS las administraciones del paciente en la clínica (cualquier evolución, sede y profesional) en una ventana móvil de 24 h, con el desglose por evolución y profesional. Las de otra clínica nunca cuentan.',
  })
  @ApiOkResponse({ type: EntryAnesthesiaDto })
  @ApiNotFoundResponse({ description: 'Paciente o evolución no encontrados' })
  listByEntry(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.anesthesia.listByEntry(patientId, entryId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'MEDICAL_HISTORY',
    patient: { param: 'patientId' },
    reason: 'ANESTHESIA_DOSE_CHECK',
  })
  @Post(`${ENTRY}/check`)
  @HttpCode(200)
  @Roles(...ANESTHESIA_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Previsualiza la dosis acumulada con un anestésico más',
    description:
      'No guarda nada. Lee la anamnesis vigente (peso y alergias) y lo ya registrado al paciente en la ventana de 24 h que contiene `administeredAt` (por defecto, ahora; la de más acumulado) en cualquier evolución y sede de la clínica (DX-418). DX-420: aplica el máximo pediátrico (< 12 años), −30 % en menores de 6 meses o con hoja de sedación en las 24 h, la edad mínima del anestésico y el tope de epinefrina por cita (0,04 mg con cardiopatía en la anamnesis), y devuelve «quedan X mg ≈ Y carpules» en `summary.remaining`.',
  })
  @ApiOkResponse({ type: AnesthesiaCheckDto })
  @ApiBadRequestResponse({ description: 'Carpules, peso u hora inválidos' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución o anestésico no encontrados',
  })
  check(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: AnesthesiaDoseCheckDto,
  ): Promise<AnesthesiaCheckResult> {
    return this.anesthesia.check(patientId, entryId, {
      anestheticId: dto.anestheticId,
      carpules: dto.carpules,
      weightKg: dto.weightKg,
      administeredAt: dto.administeredAt
        ? new Date(dto.administeredAt)
        : undefined,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'ANESTHESIA_ADMINISTRATION',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    anesthesiaSafety: true,
  })
  @Post(ENTRY)
  @Roles(...ANESTHESIA_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Registra anestesia local en la evolución (inalterable)',
    description:
      'El servidor calcula los mg, el acumulado del PACIENTE en la ventana de 24 h que contiene la administración con más acumulado (todas sus evoluciones y sedes de la clínica, DX-418) y la fracción del máximo por peso. Al llegar al 100 %, al tope de epinefrina, por debajo de la edad mínima del anestésico (DX-420) o con alergia a anestésicos responde 409 salvo `overrideReason`, que queda sellado y auditado. Dos registros simultáneos del mismo paciente se serializan (bloqueo por paciente): el segundo calcula con el primero.',
  })
  @ApiCreatedResponse({ type: RecordedAnesthesiaDto })
  @ApiBadRequestResponse({
    description:
      'Carpules, peso, hora futura, anestésico desactivado o menor de 12 años sin peso',
  })
  @ApiConflictResponse({ type: AnesthesiaConflictDto })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución o anestésico no encontrados',
  })
  record(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: RecordAnesthesiaDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RecordedAnesthesia> {
    return this.anesthesia.record(
      patientId,
      entryId,
      {
        anestheticId: dto.anestheticId,
        carpules: dto.carpules,
        weightKg: dto.weightKg,
        technique: dto.technique,
        site: dto.site,
        lot: dto.lot,
        administeredAt: dto.administeredAt
          ? new Date(dto.administeredAt)
          : undefined,
        overrideReason: dto.overrideReason,
      },
      req.user.sub,
    );
  }

  @Patch(`${ENTRY}/:id`)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la anestesia no se edita' })
  @ApiMethodNotAllowedResponse({ description: ANESTHESIA_IMMUTABLE_MESSAGE })
  rejectPatch(): never {
    throw new MethodNotAllowedException(ANESTHESIA_IMMUTABLE_MESSAGE);
  }

  @Put(`${ENTRY}/:id`)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la anestesia no se edita' })
  @ApiMethodNotAllowedResponse({ description: ANESTHESIA_IMMUTABLE_MESSAGE })
  rejectPut(): never {
    throw new MethodNotAllowedException(ANESTHESIA_IMMUTABLE_MESSAGE);
  }

  @Delete(`${ENTRY}/:id`)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la anestesia no se borra' })
  @ApiMethodNotAllowedResponse({ description: ANESTHESIA_IMMUTABLE_MESSAGE })
  rejectDelete(): never {
    throw new MethodNotAllowedException(ANESTHESIA_IMMUTABLE_MESSAGE);
  }
}
