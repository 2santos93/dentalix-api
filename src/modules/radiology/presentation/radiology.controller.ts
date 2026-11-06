import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  RADIOLOGY_READ_ROLES,
  RADIOLOGY_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateRadiologyRecordUseCase,
  GetRadiologyRecordUseCase,
  ListRadiologyDueUseCase,
  ListRadiologyRecordsUseCase,
  UpdateRadiologyRecordUseCase,
  VoidRadiologyRecordUseCase,
  type ListRadiologyDueOutput,
  type ListRadiologyOutput,
} from '../application/use-cases/radiology.use-cases';
import type { RadiologyRecordView } from '../application/radiology-view';
import {
  CreateRadiologyRecordDto,
  ListRadiologyRecordsQueryDto,
  ListRadiologyRecordsResponseDto,
  RadiologyDueQueryDto,
  RadiologyDueResponseDto,
  RadiologyRecordDto,
  UpdateRadiologyRecordDto,
  VoidRadiologyRecordDto,
} from './dto/radiology.dto';

/** 403 en español (la web lo enseña tal cual). */
export const RADIOLOGY_READ_FORBIDDEN_MESSAGE =
  'Solo odontología y administración ven el expediente de rayos X.';
export const RADIOLOGY_WRITE_FORBIDDEN_MESSAGE =
  'Solo administración registra o cambia el expediente de rayos X.';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const READ_FORBIDDEN = `${RADIOLOGY_READ_FORBIDDEN_MESSAGE} (o sede no permitida)`;
const WRITE_FORBIDDEN = `${RADIOLOGY_WRITE_FORBIDDEN_MESSAGE} (o sede no permitida)`;

/**
 * Expediente de rayos X de cada sede (DX-544): licencias de práctica y
 * controles de calidad con su vencimiento, y sus avisos en «Mi día». Leen
 * DENTIST y ADMIN; escribe solo ADMIN. Nada se borra: se anula con motivo y
 * `audit_event`.
 */
@ApiTags('radiology-records')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...RADIOLOGY_READ_ROLES)
@RolesDeniedMessage(RADIOLOGY_READ_FORBIDDEN_MESSAGE)
@Controller('radiology-records')
export class RadiologyController {
  constructor(
    private readonly listRecords: ListRadiologyRecordsUseCase,
    private readonly getRecord: GetRadiologyRecordUseCase,
    private readonly createRecord: CreateRadiologyRecordUseCase,
    private readonly updateRecord: UpdateRadiologyRecordUseCase,
    private readonly voidRecord: VoidRadiologyRecordUseCase,
    private readonly due: ListRadiologyDueUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Licencias y controles de calidad de rayos X por sede',
    description:
      'Del vencimiento más próximo al más lejano, paginados, con su estado en el día de la sede (vencido, vence pronto ≤90 días, al día o renovado). Por defecto, los no anulados. DENTIST y ADMIN.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede activa; sin ella ni `locationId`, las sedes permitidas al usuario (vista consolidada)',
  })
  @ApiOkResponse({ type: ListRadiologyRecordsResponseDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  @ApiForbiddenResponse({ description: READ_FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  list(
    @Query() query: ListRadiologyRecordsQueryDto,
  ): Promise<ListRadiologyOutput> {
    return this.listRecords.execute({
      locationId: query.locationId,
      kind: query.kind,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  // Antes de `:id`: si no, «due» llegaría como id (400 del UUID).
  @Get('due')
  @ApiOperation({
    summary:
      'Licencias y controles de rayos X vencidos o por vencer («Mi día»)',
    description:
      'DX-544: documentos vivos y sin renovar vencidos (OVERDUE) o que vencen hoy o en los próximos 90 días (DUE_SOON), contados en el día de la sede de cada uno, con la misma regla que `status` de la lista. ' +
      'En la sede activa (`X-Location-Id`); sin ella, las sedes permitidas al usuario. De lo más urgente a lo menos. DENTIST y ADMIN.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede activa; sin ella, las sedes permitidas al usuario (vista consolidada)',
  })
  @ApiOkResponse({ type: RadiologyDueResponseDto })
  @ApiBadRequestResponse({ description: 'Límite inválido' })
  @ApiForbiddenResponse({ description: READ_FORBIDDEN })
  listDue(
    @Query() query: RadiologyDueQueryDto,
  ): Promise<ListRadiologyDueOutput> {
    return this.due.execute({ limit: query.limit });
  }

  @Get(':id')
  @ApiOkResponse({ type: RadiologyRecordDto })
  @ApiForbiddenResponse({ description: READ_FORBIDDEN })
  @ApiNotFoundResponse({
    description: 'Documento no encontrado en esta clínica',
  })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<RadiologyRecordView> {
    return this.getRecord.execute(id);
  }

  @Audit({
    action: 'CREATE',
    resource: 'RADIOLOGY_RECORD',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...RADIOLOGY_WRITE_ROLES)
  @RolesDeniedMessage(RADIOLOGY_WRITE_FORBIDDEN_MESSAGE)
  @ApiCreatedResponse({
    type: RadiologyRecordDto,
    description:
      'Registrado; sin `expiresOn` se calcula: licencia I +5 años, II +4, control de calidad +2.',
  })
  @ApiBadRequestResponse({
    description:
      'Campo inválido (todos los errores en un mensaje): categoría fuera de una licencia, expedición futura, equipo de otra sede o que no es de rayos X…',
  })
  @ApiNotFoundResponse({
    description:
      'Sede, equipo o miembro del personal no encontrados en esta clínica',
  })
  @ApiForbiddenResponse({ description: WRITE_FORBIDDEN })
  create(
    @Body() dto: CreateRadiologyRecordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RadiologyRecordView> {
    return this.createRecord.execute(
      {
        kind: dto.kind,
        locationId: dto.locationId,
        equipmentId: dto.equipmentId,
        category: dto.category,
        reference: dto.reference,
        issuer: dto.issuer,
        issuedOn: dto.issuedOn,
        expiresOn: dto.expiresOn,
        officerUserId: dto.officerUserId,
        officerName: dto.officerName,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'RADIOLOGY_RECORD',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...RADIOLOGY_WRITE_ROLES)
  @RolesDeniedMessage(RADIOLOGY_WRITE_FORBIDDEN_MESSAGE)
  @ApiOkResponse({ type: RadiologyRecordDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({
    description:
      'Documento, sede, equipo o miembro del personal no encontrados en esta clínica',
  })
  @ApiConflictResponse({ description: 'El documento está anulado' })
  @ApiForbiddenResponse({ description: WRITE_FORBIDDEN })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRadiologyRecordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RadiologyRecordView> {
    return this.updateRecord.execute(
      id,
      {
        locationId: dto.locationId,
        equipmentId: dto.equipmentId,
        category: dto.category,
        reference: dto.reference,
        issuer: dto.issuer,
        issuedOn: dto.issuedOn,
        expiresOn: dto.expiresOn,
        officerUserId: dto.officerUserId,
        officerName: dto.officerName,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VOID',
    resource: 'RADIOLOGY_RECORD',
    resourceId: { param: 'id' },
  })
  @Post(':id/void')
  @HttpCode(200)
  @Roles(...RADIOLOGY_WRITE_ROLES)
  @RolesDeniedMessage(RADIOLOGY_WRITE_FORBIDDEN_MESSAGE)
  @ApiOkResponse({
    type: RadiologyRecordDto,
    description:
      'Anulado con motivo (no se borra): sigue en el expediente, marcado, y deja de avisar.',
  })
  @ApiBadRequestResponse({ description: 'Motivo inválido' })
  @ApiNotFoundResponse({
    description: 'Documento no encontrado en esta clínica',
  })
  @ApiConflictResponse({ description: 'Ya estaba anulado' })
  @ApiForbiddenResponse({ description: WRITE_FORBIDDEN })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidRadiologyRecordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RadiologyRecordView> {
    return this.voidRecord.execute(id, dto.reason, req.user.sub);
  }
}
