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
  CreateResponsiblePartyUseCase,
  ListResponsiblePartiesUseCase,
  RemoveResponsiblePartyUseCase,
  UpdateResponsiblePartyUseCase,
  type PatientResponsiblesView,
} from '../application/use-cases/responsible-parties.use-cases';
import type { ResponsiblePartyView } from '../domain/ports/responsible-party-repository.port';
import {
  CreateResponsiblePartyDto,
  PatientResponsiblesDto,
  ResponsiblePartyDto,
  UpdateResponsiblePartyDto,
} from './dto/responsible-party.dto';

const uuidPipe = (what: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException(`El identificador ${what} no es válido.`),
  });

// Auditoría (DX-203): UPDATE de PATIENT con el motivo y los NOMBRES de los
// campos enviados, nunca su contenido (datos de un tercero).
const audit = (reason: string) =>
  ({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
    reason,
  }) as const;

/**
 * Bloque «Responsable y familia» de la ficha (DX-203): quién paga y quién
 * recibe los avisos del paciente (otro paciente de la clínica o un contacto
 * sin ficha) y de quién es responsable. Datos demográficos y de cobro, no
 * clínicos: lo ven y lo gestionan los 4 roles (PATIENT_ROLES, como «Editar»
 * de la ficha; recepción lo gestiona sin ver la historia clínica).
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients/:patientId/responsible-parties')
export class PatientResponsiblePartiesController {
  constructor(
    private readonly listParties: ListResponsiblePartiesUseCase,
    private readonly createParty: CreateResponsiblePartyUseCase,
    private readonly updateParty: UpdateResponsiblePartyUseCase,
    private readonly removeParty: RemoveResponsiblePartyUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Responsables del paciente y de quién es responsable (DX-203)',
  })
  @ApiOkResponse({ type: PatientResponsiblesDto })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  list(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
  ): Promise<PatientResponsiblesView> {
    return this.listParties.execute(patientId);
  }

  @Audit(audit('RESPONSIBLE_PARTY_ADDED'))
  @Post()
  @ApiOperation({
    summary: 'Vincular un responsable: un paciente de la clínica o un contacto',
    description:
      '`responsiblePatientId` (404 si no es de esta clínica) o `fullName` con los datos del contacto. ' +
      'Un solo pagador principal (422) y el mismo paciente una sola vez (409).',
  })
  @ApiCreatedResponse({ type: ResponsiblePartyDto })
  @ApiBadRequestResponse({ description: 'Validación (mensaje en español)' })
  @ApiNotFoundResponse({
    description: 'Paciente o paciente responsable no encontrado',
  })
  @ApiConflictResponse({ description: 'Ese paciente ya es su responsable' })
  @ApiUnprocessableEntityResponse({
    description: 'Ya tiene pagador principal o el máximo de responsables',
  })
  create(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Body() dto: CreateResponsiblePartyDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<ResponsiblePartyView> {
    return this.createParty.execute(patientId, dto, req.user.sub);
  }

  @Audit(audit('RESPONSIBLE_PARTY_CHANGED'))
  @Patch(':partyId')
  @ApiOperation({ summary: 'Editar un responsable (DX-203)' })
  @ApiOkResponse({ type: ResponsiblePartyDto })
  @ApiBadRequestResponse({ description: 'Validación (mensaje en español)' })
  @ApiNotFoundResponse({ description: 'Paciente o responsable no encontrado' })
  @ApiUnprocessableEntityResponse({ description: 'Ya tiene pagador principal' })
  update(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Param('partyId', uuidPipe('del responsable')) partyId: string,
    @Body() dto: UpdateResponsiblePartyDto,
  ): Promise<ResponsiblePartyView> {
    return this.updateParty.execute(patientId, partyId, dto);
  }

  @Audit(audit('RESPONSIBLE_PARTY_REMOVED'))
  @Delete(':partyId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Quitar un responsable (DX-203)' })
  @ApiNoContentResponse({ description: 'Quitado' })
  @ApiNotFoundResponse({ description: 'Paciente o responsable no encontrado' })
  async remove(
    @Param('patientId', uuidPipe('del paciente')) patientId: string,
    @Param('partyId', uuidPipe('del responsable')) partyId: string,
  ): Promise<void> {
    await this.removeParty.execute(patientId, partyId);
  }
}
