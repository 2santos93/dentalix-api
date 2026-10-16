import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  PRESCRIPTION_ISSUE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  GetPrescriptionIssuerUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
  ListPatientPrescriptionsUseCase,
  VoidPrescriptionUseCase,
  type PrescriptionIssuerView,
} from '../application/use-cases/prescriptions.use-cases';
import type {
  Prescription,
  PrescriptionDocument,
} from '../domain/entities/prescription.entity';
import {
  IssuePrescriptionDto,
  VoidPrescriptionDto,
} from './dto/issue-prescription.dto';
import {
  AllergyConflictDto,
  PrescriptionDocumentDto,
  PrescriptionDto,
  PrescriptionIssuerDto,
} from './dto/prescription.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede desde la que se emite (da el país y la dirección). Sin ella, la sede principal.',
};

// Sin @Patch, @Put ni @Delete A PROPÓSITO: una receta emitida es documento
// médico-legal inmutable; solo se ANULA (POST :id/void). El puerto del
// repositorio no tiene update de contenido y un trigger de la base rechaza
// cualquier otro cambio (20261016200000_prescriptions). Recepción no entra.
@ApiTags('prescriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/prescriptions')
export class PatientPrescriptionsController {
  constructor(
    private readonly listPrescriptions: ListPatientPrescriptionsUseCase,
    private readonly issuePrescription: IssuePrescriptionUseCase,
  ) {}

  @Get()
  @ApiOkResponse({
    type: [PrescriptionDto],
    description: 'Más reciente primero; incluye anuladas',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<Prescription[]> {
    return this.listPrescriptions.execute(patientId);
  }

  @Post()
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: PrescriptionDto })
  @ApiBadRequestResponse({
    description:
      'Falta un campo legal según el país de la sede (mensaje en español con todos los que faltan), fecha de dispensación inválida o ES con más de un medicamento',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    type: AllergyConflictDto,
    description:
      'Alerta de alergia: un principio activo coincide con una alergia de la anamnesis y no se envió allergyOverride=true',
  })
  @ApiForbiddenResponse({ description: 'Solo DENTIST y ADMIN emiten recetas' })
  issue(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: IssuePrescriptionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Prescription> {
    return this.issuePrescription.execute(
      patientId,
      {
        items: dto.items,
        dispensationDate: dto.dispensationDate,
        notes: dto.notes,
        professionalLicense: dto.professionalLicense,
        allergyOverride: dto.allergyOverride,
      },
      req.user.sub,
    );
  }
}

@ApiTags('prescriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(
    private readonly getIssuer: GetPrescriptionIssuerUseCase,
    private readonly getPrescription: GetPrescriptionUseCase,
    private readonly voidPrescription: VoidPrescriptionUseCase,
  ) {}

  // Declarada ANTES de `:id`: Express casa las rutas en orden.
  @Get('issuer')
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({
    type: PrescriptionIssuerDto,
    description:
      'País y sede desde los que se emitiría, y el registro profesional del usuario',
  })
  issuer(@Req() req: AuthenticatedRequest): Promise<PrescriptionIssuerView> {
    return this.getIssuer.execute(req.user.sub);
  }

  @Get(':id')
  @ApiOkResponse({ type: PrescriptionDocumentDto })
  @ApiNotFoundResponse({ description: 'Receta no encontrada en esta clínica' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PrescriptionDocument> {
    return this.getPrescription.execute(id);
  }

  @Post(':id/void')
  @HttpCode(200)
  @Roles(...PRESCRIPTION_ISSUE_ROLES)
  @ApiOkResponse({ type: PrescriptionDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío' })
  @ApiNotFoundResponse({ description: 'Receta no encontrada en esta clínica' })
  @ApiConflictResponse({ description: 'La receta ya está anulada' })
  @ApiForbiddenResponse({
    description:
      'Solo quien la emitió o un ADMIN (y nunca asistente ni recepción)',
  })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPrescriptionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Prescription> {
    return this.voidPrescription.execute(id, dto.reason, {
      userId: req.user.sub,
      role: req.user.role,
    });
  }
}
