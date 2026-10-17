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
  Res,
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
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  IMPLANT_LOT_SEARCH_ROLES,
  IMPLANT_READ_ROLES,
  IMPLANT_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetImplantCardUseCase,
  ImplantCatalogUseCase,
  ListPatientImplantsUseCase,
  RegisterImplantUseCase,
  SearchImplantsByLotUseCase,
  VoidImplantUseCase,
} from '../application/use-cases/implants.use-cases';
import type {
  ImplantCatalogEntry,
  ImplantLotMatch,
  PatientImplant,
} from '../domain/entities/patient-implant.entity';
import type { ImplantCard } from '../domain/implant-card';
import { toImplantLotCsv } from '../domain/implant-lot-csv';
import {
  ImplantCardDto,
  ImplantCardQueryDto,
  ImplantCatalogEntryDto,
  ImplantLotMatchDto,
  ImplantLotQueryDto,
  PatientImplantDto,
  PrintImplantCardDto,
  RegisterImplantDto,
  VoidImplantDto,
} from './dto/implant.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

export const IMPLANT_WRITE_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración registran y anulan implantes.';
export const IMPLANT_LOT_SEARCH_FORBIDDEN_MESSAGE =
  'Solo la administración puede buscar implantes por lote y exportarlos.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa. Sin ella, la sede principal (alta) o toda la clínica (búsqueda).',
};

/** Cabecera que lee la auditoría de la búsqueda (nº de filas, DX-191). */
const RESULT_COUNT_HEADER = 'X-Result-Count';

// Sin @Patch, @Put ni @Delete A PROPÓSITO: un implante registrado es historia
// clínica inalterable; solo se ANULA (POST /implants/:id/void). El trigger
// dx_patient_implants_immutable rechaza cualquier otro cambio en la BD.
@ApiTags('implants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...IMPLANT_READ_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId')
export class PatientImplantsController {
  constructor(
    private readonly listImplants: ListPatientImplantsUseCase,
    private readonly registerImplant: RegisterImplantUseCase,
    private readonly implantCard: GetImplantCardUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    patient: { param: 'patientId' },
  })
  @Get('implants')
  @ApiOkResponse({
    type: [PatientImplantDto],
    description: 'Más reciente primero; incluye anulados',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PatientImplant[]> {
    return this.listImplants.execute(patientId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_IMPLANT',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post('implants')
  @Roles(...IMPLANT_WRITE_ROLES)
  @RolesDeniedMessage(IMPLANT_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: PatientImplantDto })
  @ApiBadRequestResponse({
    description:
      'Falta fabricante, referencia o lote, diente FDI inválido, medidas fuera de rango, fecha futura o ítem del plan de otro paciente (mensaje en español)',
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiForbiddenResponse({ description: IMPLANT_WRITE_FORBIDDEN_MESSAGE })
  register(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RegisterImplantDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientImplant> {
    return this.registerImplant.execute(patientId, dto, req.user.sub);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    patient: { param: 'patientId' },
    reason: 'IMPLANT_CARD',
  })
  @Get('implant-card')
  @ApiOperation({
    summary: 'Tarjeta de implante de la intervención de un día',
    description:
      'Identidad del paciente, centro, fecha, profesional(es) y cada componente colocado ese día (los anulados, marcados). Sin diagnóstico ni notas.',
  })
  @ApiOkResponse({ type: ImplantCardDto })
  @ApiBadRequestResponse({ description: 'Falta el día o no es AAAA-MM-DD' })
  @ApiNotFoundResponse({
    description: 'Paciente ajeno o sin implantes registrados ese día',
  })
  card(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: ImplantCardQueryDto,
  ): Promise<ImplantCard> {
    return this.implantCard.execute(patientId, query.date);
  }

  @Audit({
    action: 'PRINT',
    resource: 'PATIENT_IMPLANT',
    patient: { param: 'patientId' },
    reason: 'IMPLANT_CARD',
  })
  @Post('implant-card/print')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Imprimir/entregar la tarjeta: registra la fecha de entrega',
    description:
      'La primera impresión registra la entrega en los implantes vivos del día; una reimpresión no la cambia. Devuelve la tarjeta.',
  })
  @ApiOkResponse({ type: ImplantCardDto })
  @ApiBadRequestResponse({ description: 'Falta el día o no es AAAA-MM-DD' })
  @ApiNotFoundResponse({
    description: 'Paciente ajeno o sin implantes registrados ese día',
  })
  print(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: PrintImplantCardDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ImplantCard> {
    return this.implantCard.deliver(patientId, dto.date, req.user.sub);
  }
}

@ApiTags('implants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...IMPLANT_WRITE_ROLES)
@RolesDeniedMessage(IMPLANT_WRITE_FORBIDDEN_MESSAGE)
@Controller('implants')
export class ImplantsController {
  constructor(
    private readonly catalogUseCase: ImplantCatalogUseCase,
    private readonly voidImplant: VoidImplantUseCase,
    private readonly searchByLot: SearchImplantsByLotUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('catalog')
  @ApiOperation({
    summary: 'Fabricantes y sistemas ya usados por la clínica (autocompletar)',
  })
  @ApiOkResponse({ type: [ImplantCatalogEntryDto] })
  @ApiForbiddenResponse({ description: IMPLANT_WRITE_FORBIDDEN_MESSAGE })
  catalog(): Promise<ImplantCatalogEntry[]> {
    return this.catalogUseCase.execute();
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_IMPLANT',
    reason: 'IMPLANT_LOT_SEARCH',
    search: true,
  })
  @Get('search')
  @Roles(...IMPLANT_LOT_SEARCH_ROLES)
  @RolesDeniedMessage(IMPLANT_LOT_SEARCH_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: '¿Quién recibió este lote / esta referencia?',
    description:
      'Coincidencia exacta sin distinguir mayúsculas; con lote y REF, ambos. Incluye anulados (marcados). Solo ADMIN; queda auditada con el lote buscado y el nº de filas.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: [ImplantLotMatchDto] })
  @ApiBadRequestResponse({ description: 'Sin lote ni referencia' })
  @ApiForbiddenResponse({ description: IMPLANT_LOT_SEARCH_FORBIDDEN_MESSAGE })
  async search(
    @Query() query: ImplantLotQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImplantLotMatch[]> {
    const rows = await this.searchByLot.execute({
      ...query,
      locationId: this.tenantContext.getLocationId(),
    });
    res.setHeader(RESULT_COUNT_HEADER, String(rows.length));
    res.setHeader('Cache-Control', 'no-store');
    return rows;
  }

  @Audit({
    action: 'EXPORT',
    resource: 'PATIENT_IMPLANT',
    reason: 'IMPLANT_LOT_SEARCH',
    search: true,
  })
  @Get('search.csv')
  @Roles(...IMPLANT_LOT_SEARCH_ROLES)
  @RolesDeniedMessage(IMPLANT_LOT_SEARCH_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'La misma búsqueda por lote/REF en CSV',
    description:
      'UTF-8 con BOM. Solo ADMIN; cada descarga deja un evento EXPORT con el lote buscado y el nº de filas.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'Sin lote ni referencia' })
  @ApiForbiddenResponse({ description: IMPLANT_LOT_SEARCH_FORBIDDEN_MESSAGE })
  async csv(
    @Query() query: ImplantLotQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const rows = await this.searchByLot.execute({
      ...query,
      locationId: this.tenantContext.getLocationId(),
    });
    res.setHeader(RESULT_COUNT_HEADER, String(rows.length));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="implantes-por-lote.csv"',
    );
    // Dato personal: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return toImplantLotCsv(rows);
  }

  @Audit({
    action: 'VOID',
    resource: 'PATIENT_IMPLANT',
    resourceId: { param: 'id' },
    patient: { lookup: 'patientImplant', param: 'id' },
  })
  @Post(':id/void')
  @HttpCode(200)
  @ApiOkResponse({ type: PatientImplantDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o demasiado corto' })
  @ApiNotFoundResponse({
    description: 'Implante no encontrado en esta clínica',
  })
  @ApiConflictResponse({ description: 'El implante ya está anulado' })
  @ApiForbiddenResponse({
    description:
      'Solo quien lo registró o un ADMIN (y nunca asistente ni recepción)',
  })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidImplantDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientImplant> {
    return this.voidImplant.execute(id, dto.reason, {
      userId: req.user.sub,
      role: req.user.role,
    });
  }
}
