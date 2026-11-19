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
  Query,
  Req,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { readFile } from 'node:fs/promises';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { BANK_RECONCILIATION_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
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
  MAX_IMPORT_BYTES,
} from '../../patient-imports/domain/import-fields';
import { ImportMultipartErrorsFilter } from '../../patient-imports/presentation/import-multipart-errors.filter';
import {
  IMPORT_READ_BUSY_MESSAGE,
  IMPORT_READ_CLINIC_BUSY_MESSAGE,
  ImportReadSlotInterceptor,
  ImportUploadSlotGuard,
} from '../../patient-imports/presentation/import-read-slots';
import {
  BankReconciliationService,
  type StatementUpload,
} from '../application/bank-reconciliation.service';
import {
  AutoMatchDto,
  AutoMatchResultDto,
  BankAccountDto,
  BankMatchDto,
  BankStatementConfirmDto,
  BankStatementImportDto,
  BankStatementInspectDto,
  BankStatementPreviewDto,
  ConfirmStatementDto,
  CreateBankAccountDto,
  CreateBankMatchDto,
  IdDto,
  MovementCandidatesDto,
  PreviewStatementDto,
  ReconciliationItemsDto,
  ReconciliationItemsQueryDto,
  ReconciliationPeriodQueryDto,
  ReconciliationSummaryDto,
  UpdateBankAccountDto,
} from './dto/bank-reconciliation.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

export const BANK_RECONCILIATION_FORBIDDEN_MESSAGE =
  'Solo un administrador de la clínica puede conciliar con el extracto del banco.';

const FILE_INTERCEPTOR = FileInterceptor('file', {
  // SEC-046 (como DX-107): el cuerpo se recibe con el semáforo de subidas de
  // las importaciones a un temporal en disco que borra UploadSlotInterceptor
  // al terminar (también con error o si el cliente aborta): el extracto NO
  // se guarda. La plaza de LECTURA se toma después, con el fichero en disco.
  dest: UPLOAD_TEMP_DIR,
  defParamCharset: 'utf8',
  limits: {
    fileSize: MAX_IMPORT_BYTES,
    files: 1,
    fields: 3,
    fieldSize: 8 * 1024,
  },
});

const FILE_BODY = {
  type: 'string',
  format: 'binary',
  description:
    'Extracto en CSV (UTF-8, Latin-1 o UTF-16; «,» «;» o tabulador) o .xlsx; hasta 5 MB y 10.000 filas',
} as const;

const READ_BUSY_RESPONSE = {
  description: `${UPLOAD_BUSY_MESSAGE} / ${IMPORT_READ_CLINIC_BUSY_MESSAGE} / ${IMPORT_READ_BUSY_MESSAGE}. Siempre con Retry-After (SEC-046: las mismas plazas de lectura que la importación de pacientes).`,
};

async function loadUpload(
  file: Express.Multer.File | undefined,
): Promise<StatementUpload | undefined> {
  if (!file?.path) return undefined;
  return {
    originalname: file.originalname,
    size: file.size,
    buffer: await readFile(file.path),
  };
}

/** `mapping` del multipart (JSON). La forma la valida el dominio. */
export function parseMappingJson(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') {
    throw new BadRequestException('Elige las columnas del extracto.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException(
      'El mapeo de columnas no es válido: debe ser un JSON con la cabecera de cada dato.',
    );
  }
}

/**
 * Conciliación de transferencias y pagos móviles contra el extracto del banco
 * (DX-571). Solo ADMIN (un ADMIN no tiene restricción de sede: la cuenta es
 * de la clínica). El extracto no se guarda; de cada entrada quedan fecha,
 * referencia, importe y descripción truncada. Inspección y vista previa no
 * escriben (sin auditoría, como `inspect` de DX-107); importar, emparejar a
 * mano y deshacer sí se auditan, y las listas (con nombres de pacientes) se
 * auditan como VIEW de la cuenta.
 */
@ApiTags('bank-reconciliation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@UseFilters(ImportMultipartErrorsFilter)
@Roles(...BANK_RECONCILIATION_ROLES)
@RolesDeniedMessage(BANK_RECONCILIATION_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: BANK_RECONCILIATION_FORBIDDEN_MESSAGE })
@Controller('bank-reconciliation')
export class BankReconciliationController {
  constructor(private readonly service: BankReconciliationService) {}

  @Get('accounts')
  @ApiOperation({
    summary:
      'Cuentas de conciliación de la clínica, con sus medios y su última importación',
  })
  @ApiOkResponse({ type: [BankAccountDto] })
  listAccounts() {
    return this.service.listAccounts();
  }

  @Audit({
    action: 'CREATE',
    resource: 'BANK_ACCOUNT',
    resourceId: { response: 'id' },
  })
  @Post('accounts')
  @ApiOperation({ summary: 'Crear una cuenta de conciliación' })
  @ApiCreatedResponse({ type: BankAccountDto })
  @ApiConflictResponse({
    description:
      'BANK_ACCOUNT_NAME_TAKEN, BANK_PAYMENT_METHOD_TAKEN, BANK_PAYMENT_METHOD_INVALID o BANK_CURRENCY_INVALID',
  })
  createAccount(
    @Body() dto: CreateBankAccountDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.createAccount(
      {
        name: dto.name,
        currency: dto.currency,
        amountTolerance: dto.amountTolerance ?? 0,
        paymentMethodIds: dto.paymentMethodIds,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
  })
  @Patch('accounts/:id')
  @ApiOperation({
    summary:
      'Cambiar nombre, moneda (sin movimientos), tolerancia, medios o activa',
  })
  @ApiOkResponse({ type: BankAccountDto })
  @ApiNotFoundResponse({ description: 'No existe esa cuenta.' })
  @ApiConflictResponse({
    description: 'Nombre o medio en uso, o moneda con movimientos',
  })
  updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.service.updateAccount(id, dto);
  }

  @Get('accounts/:id/statements')
  @ApiOperation({
    summary: 'Historial de extractos importados en la cuenta (50 últimos)',
  })
  @ApiOkResponse({ type: [BankStatementImportDto] })
  @ApiNotFoundResponse({ description: 'No existe esa cuenta.' })
  listImports(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listImports(id);
  }

  @Post('accounts/:id/statements/inspect')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Paso 1: leer el extracto (cabeceras, mapeo sugerido o guardado y primeras filas)',
    description: 'No escribe nada.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: FILE_BODY },
    },
  })
  @ApiOkResponse({ type: BankStatementInspectDto })
  @ApiBadRequestResponse({
    description: 'Archivo vacío, de otro formato o con cabeceras repetidas',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('bank-statement')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async inspect(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.service.inspect(id, await loadUpload(file));
  }

  @Post('accounts/:id/statements/preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paso 2: vista previa con el mapeo (sin escribir)',
    description:
      'Entradas nuevas y ya importadas, salidas ignoradas, filas con error y las primeras 10 entradas. No guarda nada: la confirmación vuelve a subir el mismo archivo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'mapping'],
      properties: {
        file: FILE_BODY,
        mapping: {
          type: 'string',
          description: 'JSON BankStatementMappingDto',
        },
      },
    },
  })
  @ApiOkResponse({ type: BankStatementPreviewDto })
  @ApiBadRequestResponse({
    description: 'Archivo o mapeo inválidos (mensaje en español)',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('bank-statement')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: PreviewStatementDto,
  ) {
    return this.service.preview(
      id,
      await loadUpload(file),
      parseMappingJson(dto.mapping),
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'BANK_STATEMENT_IMPORT',
    resourceId: { response: 'id' },
    reason: 'IMPORT_CONFIRMED',
    importBatch: true,
  })
  @Post('accounts/:id/statements')
  @ApiOperation({
    summary: 'Paso 3: importar el extracto y emparejar solo',
    description:
      'Guarda las entradas nuevas (las ya importadas no se duplican: clave natural por cuenta), guarda el mapeo en la cuenta y empareja por referencia normalizada (DX-395), importe con la tolerancia de la cuenta y ±5 días. El archivo no se guarda.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'mapping', 'fileSha256'],
      properties: {
        file: FILE_BODY,
        mapping: {
          type: 'string',
          description: 'JSON BankStatementMappingDto',
        },
        fileSha256: { type: 'string', description: 'El de la vista previa' },
      },
    },
  })
  @ApiCreatedResponse({ type: BankStatementConfirmDto })
  @ApiBadRequestResponse({ description: 'Archivo o mapeo inválidos' })
  @ApiConflictResponse({
    description: 'BANK_STATEMENT_CHANGED o BANK_ACCOUNT_INACTIVE',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiServiceUnavailableResponse(READ_BUSY_RESPONSE)
  @RateLimit('bank-statement')
  @UseGuards(ImportUploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FILE_INTERCEPTOR,
    ImportReadSlotInterceptor,
  )
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ConfirmStatementDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.confirm(
      id,
      await loadUpload(file),
      parseMappingJson(dto.mapping),
      dto.fileSha256,
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'RECONCILIATION_SUMMARY',
  })
  @Get('accounts/:id/summary')
  @ApiOperation({ summary: 'Cuántos hay en cada lista del período' })
  @ApiOkResponse({ type: ReconciliationSummaryDto })
  summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReconciliationPeriodQueryDto,
  ) {
    return this.service.summary(id, query.from, query.to);
  }

  @Audit({
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'RECONCILIATION_ITEMS',
  })
  @Get('accounts/:id/items')
  @ApiOperation({
    summary: 'Una de las cuatro listas del período, paginada',
    description:
      'CONCILIADO: emparejados activos cuyo movimiento cae en el período. IMPORTE_DISTINTO: movimiento y abono con la misma referencia y fecha cercana, importe fuera de la tolerancia. MOVIMIENTO_SIN_ABONO: entradas sin abono. SIN_MOVIMIENTO: abonos de los medios de la cuenta, en su moneda y del período, sin movimiento (con su comprobante).',
  })
  @ApiOkResponse({ type: ReconciliationItemsDto })
  items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReconciliationItemsQueryDto,
  ) {
    return this.service.items(
      id,
      query.from,
      query.to,
      query.status,
      query.page ?? 1,
      query.pageSize ?? 25,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'BANK_ACCOUNT',
    resourceId: { param: 'id' },
    reason: 'AUTO_MATCH',
  })
  @Post('accounts/:id/auto-match')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Volver a emparejar solo el período (abonos registrados después de importar)',
  })
  @ApiOkResponse({ type: AutoMatchResultDto })
  autoMatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AutoMatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.autoMatch(id, dto.from, dto.to, req.user.sub);
  }

  @Audit({
    action: 'VIEW',
    resource: 'BANK_ACCOUNT',
    reason: 'RECONCILIATION_CANDIDATES',
  })
  @Get('movements/:id/candidates')
  @ApiOperation({
    summary:
      'Abonos y reportes de pago pendientes (DX-569) que pueden ser este movimiento',
  })
  @ApiOkResponse({ type: MovementCandidatesDto })
  @ApiNotFoundResponse({ description: 'No existe ese movimiento.' })
  candidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.candidates(id);
  }

  @Audit({
    action: 'CREATE',
    resource: 'BANK_RECONCILIATION_MATCH',
    resourceId: { response: 'id' },
    reason: 'MANUAL_MATCH',
  })
  @Post('matches')
  @ApiOperation({ summary: 'Emparejar a mano un movimiento con un abono' })
  @ApiCreatedResponse({ type: BankMatchDto })
  @ApiNotFoundResponse({
    description: 'No existe el movimiento o el abono (o está anulado).',
  })
  @ApiConflictResponse({
    description:
      'BANK_MOVEMENT_ALREADY_MATCHED, BANK_PAYMENT_ALREADY_MATCHED o BANK_PAYMENT_NOT_IN_ACCOUNT',
  })
  match(@Body() dto: CreateBankMatchDto, @Req() req: AuthenticatedRequest) {
    return this.service.match(dto.movementId, dto.paymentId, req.user.sub);
  }

  @Audit({
    action: 'DELETE',
    resource: 'BANK_RECONCILIATION_MATCH',
    resourceId: { param: 'id' },
    reason: 'MANUAL_UNMATCH',
  })
  @Delete('matches/:id')
  @ApiOperation({
    summary:
      'Deshacer un emparejado (queda en la historia; el movimiento vuelve a «Sin abono»)',
  })
  @ApiOkResponse({ type: IdDto })
  @ApiNotFoundResponse({ description: 'No existe ese emparejado.' })
  @ApiConflictResponse({ description: 'BANK_MATCH_ALREADY_ENDED' })
  unmatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.unmatch(id, req.user.sub);
  }
}
