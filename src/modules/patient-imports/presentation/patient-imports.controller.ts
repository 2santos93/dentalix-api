import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_IMPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { UPLOAD_TEMP_DIR } from '../../../shared/storage/local-file';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotInterceptor,
} from '../../../shared/storage/upload-slots';
import {
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_FIELD_KEYS,
  MAX_IMPORT_BYTES,
  type ImportFieldKey,
} from '../domain/import-fields';
import type { ColumnMapping } from '../domain/column-mapping';
import {
  ACTIVE_IMPORT_MESSAGE,
  BALANCES_NOT_EDITABLE_MESSAGE,
  BALANCE_REPORT_GONE_MESSAGE,
  NOT_FOUND_MESSAGE,
  PatientImportsService,
  REPORT_GONE_MESSAGE,
  type BatchDetail,
  type InspectResult,
  type UploadedFile as ImportUpload,
} from '../application/patient-imports.use-cases';
import {
  ConfirmPatientImportDto,
  CreatePatientImportDto,
  UploadBalancesDto,
  ListPatientImportsQueryDto,
  PatientImportBatchDetailDto,
  PatientImportInspectDto,
  PatientImportListDto,
} from './dto/patient-import.dto';
import { ImportMultipartErrorsFilter } from './import-multipart-errors.filter';
import {
  IMPORT_READ_BUSY_MESSAGE,
  IMPORT_READ_CLINIC_BUSY_MESSAGE,
  ImportReadSlotInterceptor,
  ImportUploadSlotGuard,
} from './import-read-slots';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

export const PATIENT_IMPORT_FORBIDDEN_MESSAGE =
  'Solo un administrador de la clínica puede importar pacientes.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede por defecto del lote (indicativo de los teléfonos). Sin ella, la sede de escritura.',
};

const FILE_INTERCEPTOR = FileInterceptor('file', {
  // SEC-046: el cuerpo se recibe con un semáforo propio y los plazos de las
  // subidas (ImportUploadSlotGuard, DX-259) a un temporal en disco (lo borra
  // UploadSlotInterceptor al terminar, también con error o si el cliente
  // aborta), no a un Buffer. La plaza de LECTURA (ImportReadSlotInterceptor)
  // se toma después, con el fichero ya en disco.
  dest: UPLOAD_TEMP_DIR,
  defParamCharset: 'utf8',
  limits: {
    fileSize: MAX_IMPORT_BYTES,
    files: 1,
    fields: 4,
    fieldSize: 8 * 1024,
  },
});

const FILE_BODY = {
  type: 'string',
  format: 'binary',
  description:
    'CSV (UTF-8, Latin-1 o UTF-16; separador «,» «;» o tabulador) o .xlsx; hasta 5 MB y 10.000 filas',
} as const;

const READ_BUSY_RESPONSE = {
  description: `${UPLOAD_BUSY_MESSAGE} (semáforo de subidas, antes de recibir el cuerpo) / ${IMPORT_READ_CLINIC_BUSY_MESSAGE} / ${IMPORT_READ_BUSY_MESSAGE} (con el fichero ya recibido). Siempre con Retry-After. SEC-046: como mucho 2 lecturas a la vez por réplica y 1 por clínica (configurable).`,
};

/**
 * SEC-046: el fichero que multer dejó en el temporal, ya en memoria para el
 * lector. Se llama dentro del handler, con la plaza de lectura tomada.
 */
async function loadUpload(
  file: Express.Multer.File | undefined,
): Promise<ImportUpload | undefined> {
  if (!file?.path) return undefined;
  return {
    originalname: file.originalname,
    size: file.size,
    buffer: await readFile(file.path),
  };
}

const INVALID_MAPPING_MESSAGE =
  'El mapeo de columnas no es válido: debe ser un JSON { campo: cabecera }.';

/** `mapping` del multipart → { campo: cabecera } con campos conocidos. */
export function parseMappingField(
  raw: string | undefined,
): ColumnMapping | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException(INVALID_MAPPING_MESSAGE);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException(INVALID_MAPPING_MESSAGE);
  }
  const out: ColumnMapping = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!IMPORT_FIELD_KEYS.includes(key as ImportFieldKey)) {
      throw new BadRequestException(`El campo «${key}» no se puede importar.`);
    }
    if (value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 200) {
      throw new BadRequestException(INVALID_MAPPING_MESSAGE);
    }
    out[key as ImportFieldKey] = value;
  }
  return out;
}

/**
 * Importación de pacientes desde CSV/XLSX (DX-107). Solo ADMIN. El fichero
 * no se guarda: multer lo deja en un temporal en disco que se borra al
 * terminar, se lee con una plaza de lectura (SEC-046) y se guarda su hash y
 * lo necesario para el informe. `GET /:id` no se audita a propósito: la pantalla lo consulta cada
 * pocos segundos mientras importa; su informe (`errors.csv`) sí.
 */
@ApiTags('patient-imports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@UseFilters(ImportMultipartErrorsFilter)
@Roles(...PATIENT_IMPORT_ROLES)
@RolesDeniedMessage(PATIENT_IMPORT_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: PATIENT_IMPORT_FORBIDDEN_MESSAGE })
@Controller('patient-imports')
export class PatientImportsController {
  constructor(private readonly imports: PatientImportsService) {}

  @Get('template')
  @ApiOperation({
    summary: 'Plantilla CSV con las columnas admitidas',
    description:
      'UTF-8 con BOM; trae dos filas de ejemplo ficticias que hay que borrar antes de importar.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Plantilla CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header(
    'Content-Disposition',
    'attachment; filename="plantilla-pacientes.csv"',
  )
  template(): string {
    return this.imports.template();
  }

  @Get('balances-template')
  @ApiOperation({
    summary: 'Plantilla CSV de la hoja de saldos («Saldo migrado», DX-262)',
    description:
      'numero_documento, importe, moneda, fecha_antiguedad (opcional) y concepto (opcional). UTF-8 con BOM; una fila de ejemplo ficticia que hay que borrar.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Plantilla CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="plantilla-saldos.csv"')
  balanceTemplate(): Promise<string> {
    return this.imports.balanceTemplate();
  }

  @Post('inspect')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Paso 1: leer el archivo (cabeceras, mapeo sugerido y primeras filas)',
    description: 'No escribe nada ni crea lote.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: FILE_BODY },
    },
  })
  @ApiOkResponse({ type: PatientImportInspectDto })
  @ApiBadRequestResponse({
    description:
      'Archivo vacío, de otro formato, con cabeceras repetidas o con más de 10.000 filas',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('patient-import')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async inspect(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<InspectResult> {
    return this.imports.inspect(await loadUpload(file));
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { response: 'id' },
    reason: 'IMPORT_VALIDATED',
    importBatch: true,
  })
  @Post()
  @ApiOperation({
    summary: 'Paso 2: validar el archivo con el mapeo (dry-run)',
    description:
      'Valida cada fila, deduplica por (tipo, nº de documento) dentro del archivo y contra la clínica, y guarda el lote VALIDATED con sus totales y errores por fila. NO crea ni modifica ningún paciente. Un lote VALIDATED anterior del mismo usuario caduca.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: FILE_BODY,
        mapping: {
          type: 'string',
          description: 'JSON { campo: cabecera }; sin él, el mapeo sugerido',
        },
        defaultDocType: {
          type: 'string',
          enum: ['CC', 'TI', 'CE', 'PASSPORT', 'OTHER'],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: PatientImportBatchDetailDto })
  @ApiBadRequestResponse({
    description: 'Archivo o mapeo inválidos (mensaje en español)',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('patient-import')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreatePatientImportDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BatchDetail> {
    return this.imports.dryRun(
      await loadUpload(file),
      {
        columns: parseMappingField(dto.mapping),
        defaultDocType: dto.defaultDocType,
      },
      req.user.sub,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Historial de importaciones confirmadas (más reciente primero)',
  })
  @ApiOkResponse({ type: PatientImportListDto })
  list(@Query() query: ListPatientImportsQueryDto) {
    return this.imports.list(query.page ?? 1, query.pageSize ?? 20);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Estado, progreso y errores por fila de un lote' })
  @ApiOkResponse({ type: PatientImportBatchDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BatchDetail> {
    return this.imports.get(id);
  }

  @Audit({
    action: 'EXPORT',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_ERRORS',
  })
  @Get(':id/errors.csv')
  @ApiOperation({
    summary: 'Informe de errores y duplicados por fila (CSV)',
    description:
      'Fila, columna, tipo, motivo y valor. UTF-8 con BOM; fórmulas neutralizadas (inyección CSV).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiGoneResponse({ description: REPORT_GONE_MESSAGE })
  async errors(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.imports.errorsCsv(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${report.fileName}"`,
    );
    // Dato personal: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return report.csv;
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_VALIDATED',
    importBatch: true,
  })
  @Post(':id/balances')
  @ApiOperation({
    summary:
      'Hoja de saldos del lote (DX-262): validar el «Saldo migrado» (dry-run)',
    description:
      'Solo con el lote validado y sin confirmar. Valida cada fila (documento del paciente en la clínica o en el archivo de pacientes del lote, importe > 0, moneda admitida, fecha de antigüedad no futura, concepto ≤ 200), suma las filas del mismo paciente y moneda y devuelve el total por moneda del archivo y de lo que se importará. NO crea ningún saldo: se importan al confirmar el lote, después de los pacientes. Volver a subirla la reemplaza.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: FILE_BODY,
        addToExisting: {
          type: 'string',
          enum: ['true', 'false'],
          description:
            '«Añadir aunque ya tenga saldo migrado» (QA D1). Por defecto false: un paciente con un saldo migrado vivo en esa moneda de otro lote no recibe otro (error de la fila con el importe, el lote y el corte del existente).',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: PatientImportBatchDetailDto })
  @ApiBadRequestResponse({
    description:
      'Archivo vacío, de otro formato, sin las columnas de documento, importe o moneda; addToExisting que no es true/false',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiConflictResponse({ description: BALANCES_NOT_EDITABLE_MESSAGE })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('patient-import')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async balances(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadBalancesDto,
  ): Promise<BatchDetail> {
    return this.imports.dryRunBalances(
      id,
      await loadUpload(file),
      dto.addToExisting === 'true',
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_REMOVED',
    importBatch: true,
  })
  @Delete(':id/balances')
  @ApiOperation({
    summary: 'Quitar la hoja de saldos de un lote aún sin confirmar (DX-262)',
  })
  @ApiOkResponse({ type: PatientImportBatchDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiConflictResponse({ description: BALANCES_NOT_EDITABLE_MESSAGE })
  removeBalances(@Param('id', ParseUUIDPipe) id: string): Promise<BatchDetail> {
    return this.imports.removeBalances(id);
  }

  @Audit({
    action: 'EXPORT',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCE_ERRORS',
  })
  @Get(':id/balances/errors.csv')
  @ApiOperation({
    summary: 'Informe de errores y avisos de la hoja de saldos (CSV, DX-262)',
    description:
      'Fila, columna, tipo, motivo y valor. UTF-8 con BOM; fórmulas neutralizadas (inyección CSV).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiGoneResponse({ description: BALANCE_REPORT_GONE_MESSAGE })
  async balanceErrors(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.imports.balanceErrorsCsv(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${report.fileName}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return report.csv;
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_BALANCES_UNDONE',
    importBatch: true,
  })
  @Post(':id/balances/undo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Retirar solo los saldos migrados del lote (DX-262)',
    description:
      'Retira en blando los «Saldo migrado» vivos del lote aunque sus pacientes ya tengan citas u otra actividad (el lote sigue importado). Se niega (409) si alguno tiene abonos vivos: hay que anularlos antes.',
  })
  @ApiOkResponse({ type: PatientImportBatchDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiConflictResponse({
    description: 'El lote no está terminado o algún saldo tiene abonos',
  })
  undoBalances(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BatchDetail> {
    return this.imports.undoBalances(id, req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_CONFIRMED',
    importBatch: true,
  })
  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paso 3: confirmar e importar en segundo plano',
    description:
      'Encola el trabajo que importa el lote por bloques (la clínica sigue trabajando): primero los pacientes y después, si el lote trae hoja de saldos, un «Saldo migrado» por paciente y moneda (DX-262). Una importación en curso por clínica. Los pacientes quedan SIN autorización de datos (Ley 1581) registrada: la ficha la marca pendiente.',
  })
  @ApiOkResponse({ type: PatientImportBatchDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiConflictResponse({
    description: `${ACTIVE_IMPORT_MESSAGE} · Lote ya confirmado, caducado o sin filas`,
  })
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPatientImportDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BatchDetail> {
    return this.imports.confirm(id, dto.duplicateMode, req.user.sub);
  }

  @Audit({
    action: 'DELETE',
    resource: 'PATIENT_IMPORT_BATCH',
    resourceId: { param: 'id' },
    reason: 'IMPORT_UNDONE',
    importBatch: true,
  })
  @Post(':id/undo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deshacer el lote',
    description:
      'Retira en blando SOLO los pacientes que creó el lote, revierte los campos que rellenó (si siguen con el valor del lote) y retira sus saldos migrados (DX-262). Se niega (409) si alguno de los creados ya tiene citas, historia clínica, planes, pagos, saldos de otra importación u otros datos, o si algún saldo migrado del lote tiene abonos imputados.',
  })
  @ApiOkResponse({ type: PatientImportBatchDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND_MESSAGE })
  @ApiConflictResponse({
    description: 'El lote no está terminado o hay pacientes con actividad',
  })
  undo(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BatchDetail> {
    return this.imports.undo(id, req.user.sub);
  }
}
