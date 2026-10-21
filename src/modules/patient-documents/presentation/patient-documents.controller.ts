import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_DOCUMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CompletePatientDocumentUploadUseCase,
  CreatePatientDocumentUploadUseCase,
  GetPatientDocumentUrlUseCase,
  GetPatientDocumentUseCase,
  ListPatientDocumentsUseCase,
  UploadPatientDocumentUseCase,
  VoidPatientDocumentUseCase,
  type PatientDocumentUploadTicket,
  type PatientDocumentUrl,
  type PatientDocumentView,
} from '../application/use-cases/patient-documents.use-cases';
import {
  FILE_TOO_LARGE_MESSAGE,
  MAX_PATIENT_DOCUMENT_BYTES,
} from '../domain/document-content';
import {
  CompletePatientDocumentUploadDto,
  CreatePatientDocumentUploadDto,
  ListPatientDocumentsQueryDto,
  PatientDocumentDto,
  PatientDocumentUploadDto,
  PatientDocumentUrlDto,
  UploadPatientDocumentDto,
  VoidPatientDocumentDto,
} from './dto/patient-document.dto';
import { MultipartErrorsFilter } from './multipart-errors.filter';
import { UPLOAD_TEMP_DIR } from '../../../shared/storage/local-file';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
} from '../../../shared/storage/upload-slots';
import { STORAGE_UNAVAILABLE_MESSAGE } from '../../../shared/storage/storage-errors';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const P = { param: 'patientId' } as const;

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, la sede principal.',
};

const NOT_FOUND = 'Paciente o documento no encontrado en esta clínica';

// Sin @Patch, @Put ni @Delete A PROPÓSITO: un documento subido es parte de la
// historia clínica, inalterable; solo se ANULA (POST …/:id/void) y sigue en la
// ficha. El trigger dx_patient_documents_immutable rechaza cualquier otro
// cambio en la BD, y el objeto del almacén nunca se borra desde la API.
@ApiTags('patient-documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@UseFilters(MultipartErrorsFilter)
@Roles(...PATIENT_DOCUMENT_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/documents')
export class PatientDocumentsController {
  constructor(
    private readonly uploadDocument: UploadPatientDocumentUseCase,
    private readonly createUpload: CreatePatientDocumentUploadUseCase,
    private readonly completeUpload: CompletePatientDocumentUploadUseCase,
    private readonly listDocuments: ListPatientDocumentsUseCase,
    private readonly getDocument: GetPatientDocumentUseCase,
    private readonly documentUrl: GetPatientDocumentUrlUseCase,
    private readonly voidDocument: VoidPatientDocumentUseCase,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { response: 'id' },
    patient: P,
  })
  @Post()
  @ApiOperation({
    summary:
      'Subir un documento a la ficha del paciente (multipart, por la API)',
    description:
      'PDF, JPG, PNG, HEIC, DOCX o DICOM de hasta 20 MB. El tipo lo decide el contenido; si no cuadra con el nombre o la etiqueta, 400. El mismo contenido vigente dos veces en la ficha, 409. DX-259: el fichero pasa por un temporal en disco y un semáforo de subidas por réplica (503 con Retry-After si no hay plaza); la web usa la subida directa al almacén (`upload-url` + `complete`).',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'category'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PDF, JPG, PNG, HEIC, DOCX o DICOM de hasta 20 MB',
        },
        // El enum con nombre que ya registra PatientDocumentDto (enumName).
        category: { $ref: getSchemaPath('PatientDocumentCategory') },
        clinicalDate: { type: 'string', format: 'date' },
        toothNumbers: {
          type: 'string',
          example: '11,21',
          description: 'Dientes FDI separados por comas',
        },
        notes: { type: 'string', maxLength: 500 },
      },
    },
  })
  @ApiCreatedResponse({ type: PatientDocumentDto })
  @ApiBadRequestResponse({
    description:
      'Falta el archivo, tipo no admitido, contenido que no coincide con su tipo, categoría, dientes, fecha o notas inválidos (mensaje en español)',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Este archivo ya está en la ficha del paciente.',
  })
  @ApiServiceUnavailableResponse({
    description: `${UPLOAD_BUSY_MESSAGE} / ${STORAGE_UNAVAILABLE_MESSAGE} (con Retry-After)`,
  })
  @UseGuards(UploadSlotGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      // DX-259: a un temporal en disco (lo borra UploadSlotGuard al cerrar la
      // respuesta), no a un Buffer en memoria.
      dest: UPLOAD_TEMP_DIR,
      // Los navegadores mandan el nombre del fichero en UTF-8 crudo; sin
      // esto multer lo lee como latin1 («RemisiÃ³n.pdf»).
      defParamCharset: 'utf8',
      limits: {
        fileSize: MAX_PATIENT_DOCUMENT_BYTES,
        files: 1,
        fields: 8,
        fieldSize: 8 * 1024,
      },
    }),
  )
  upload(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: UploadPatientDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientDocumentView> {
    return this.uploadDocument.execute(patientId, dto, file, req.user.sub);
  }

  @Post('upload-url')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Autorización para subir un documento directamente al almacén',
    description:
      'DX-259: devuelve un POST prefirmado (S3) de pocos minutos para UN fichero: la clave la fija la API, de 1 B a 20 MB y con el SHA-256 declarado (el almacén rechaza otro contenido). El navegador envía `fields` y el fichero (campo `file`, al final) a `url` y después llama a `POST …/:documentId/complete`. Con el almacén en disco (desarrollo) `url` es la propia API (`/files/uploads`), con las mismas reglas. Nada llega a la ficha ni se audita hasta `complete`.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: PatientDocumentUploadDto })
  @ApiBadRequestResponse({
    description: 'Tamaño o huella SHA-256 no válidos, o archivo vacío',
  })
  @ApiPayloadTooLargeResponse({ description: FILE_TOO_LARGE_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Este archivo ya está en la ficha del paciente.',
  })
  uploadUrl(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePatientDocumentUploadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientDocumentUploadTicket> {
    return this.createUpload.execute(patientId, dto, req.user.sub);
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { response: 'id' },
    patient: P,
  })
  @Post(':id/complete')
  @ApiOperation({
    summary:
      'Terminar la subida directa: comprobar el fichero y crearlo en la ficha',
    description:
      'DX-259: comprueba el objeto subido con `upload-url` (de este usuario y paciente): tamaño y SHA-256 del almacén, y el tipo por contenido leyendo los primeros 64 KB con `Range`. Mismas reglas que el multipart: si el contenido no es de la lista blanca, no cuadra con lo declarado, o el tamaño o la huella no cuadran, el objeto se borra y la respuesta es 400 en español; el mismo contenido vigente, 409. Errores del formulario: 400 y el fichero se conserva para reintentar. Repetirlo con un documento ya creado lo devuelve.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'El `documentId` de `upload-url`',
  })
  @ApiCreatedResponse({ type: PatientDocumentDto })
  @ApiBadRequestResponse({
    description:
      'Tipo no admitido, contenido que no coincide con su tipo, tamaño o huella que no cuadran, o campos del formulario inválidos (mensaje en español)',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado, o subida inexistente, caducada o de otra persona',
  })
  @ApiConflictResponse({
    description: 'Este archivo ya está en la ficha del paciente.',
  })
  @ApiServiceUnavailableResponse({
    description: `${STORAGE_UNAVAILABLE_MESSAGE} (con Retry-After)`,
  })
  complete(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompletePatientDocumentUploadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientDocumentView> {
    return this.completeUpload.execute(patientId, id, dto, req.user.sub);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    patient: P,
    reason: 'DOCUMENT_LIST',
  })
  @Get()
  @ApiOkResponse({
    type: [PatientDocumentDto],
    description: 'Más reciente primero; incluye anulados',
  })
  @ApiBadRequestResponse({ description: 'Categoría o diente inválidos' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: ListPatientDocumentsQueryDto,
  ): Promise<PatientDocumentView[]> {
    return this.listDocuments.execute(patientId, query);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
  })
  @Get(':id')
  @ApiOkResponse({ type: PatientDocumentDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  detail(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientDocumentView> {
    return this.getDocument.execute(patientId, id);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'DOCUMENT_VIEW',
  })
  @Get(':id/url/inline')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'URL firmada para VER el documento en el navegador',
    description:
      'Solo PDF, JPG y PNG. Caduca a los pocos minutos; disposición, nombre y tipo van firmados.',
  })
  @ApiOkResponse({ type: PatientDocumentUrlDto })
  @ApiBadRequestResponse({ description: 'Este tipo solo se puede descargar.' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  inlineUrl(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientDocumentUrl> {
    return this.documentUrl.execute(patientId, id, 'inline');
  }

  @Audit({
    action: 'EXPORT',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
    reason: 'DOCUMENT_DOWNLOAD',
  })
  @Get(':id/url/download')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'URL firmada para DESCARGAR el documento (cualquier tipo)',
  })
  @ApiOkResponse({ type: PatientDocumentUrlDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  downloadUrl(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientDocumentUrl> {
    return this.documentUrl.execute(patientId, id, 'attachment');
  }

  @Audit({
    action: 'VOID',
    resource: 'PATIENT_DOCUMENT',
    resourceId: { param: 'id' },
    patient: P,
  })
  @Post(':id/void')
  @HttpCode(200)
  @ApiOkResponse({ type: PatientDocumentDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o demasiado corto' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'El documento ya está anulado.' })
  @ApiForbiddenResponse({
    description:
      'Solo quien subió el documento o un administrador puede anularlo.',
  })
  void(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPatientDocumentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientDocumentView> {
    return this.voidDocument.execute(patientId, id, dto.reason, {
      userId: req.user.sub,
      role: req.user.role,
    });
  }
}
