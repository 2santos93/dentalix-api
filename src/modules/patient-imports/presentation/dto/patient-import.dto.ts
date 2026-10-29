import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  type DocumentType,
  PatientImportDuplicateMode,
  PatientImportFileFormat,
  PatientImportStatus,
} from '@prisma/client';
import { IMPORT_FIELD_KEYS } from '../../domain/import-fields';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import {
  DOC_TYPE_INPUTS,
  type DocTypeInput,
} from '../../../patients/presentation/dto/doc-type-input';

const FIELD_KEYS_DOC = IMPORT_FIELD_KEYS.join(', ');

/**
 * Campos de texto del multipart del dry-run (el fichero va en `file`).
 * `mapping` es un JSON `{ campo: cabecera }`; lo valida el controlador con
 * mensajes en español.
 */
export class CreatePatientImportDto {
  @ApiPropertyOptional({
    description: `JSON con el mapeo campo de Dentalix → cabecera del archivo, p. ej. {"firstName":"Nombre","docNumber":"Documento"}. Campos: ${FIELD_KEYS_DOC}. Sin él, el mapeo sugerido.`,
    example:
      '{"firstName":"Nombres","lastName":"Apellidos","docNumber":"Documento"}',
  })
  @IsOptional()
  @IsString({ message: 'El mapeo de columnas debe ser un JSON.' })
  @MaxLength(4000, { message: 'El mapeo de columnas es demasiado largo.' })
  mapping?: string;

  // DX-327 (R9): en la fase 1 se aceptan también los códigos anteriores (web
  // anterior); el controlador los traduce. OpenAPI publica solo los genéricos.
  @ApiPropertyOptional({
    enum: DOCUMENT_TYPES,
    enumName: 'DocType',
    description:
      'Tipo de documento cuando la columna no está o la celda va vacía',
  })
  @IsOptional()
  @IsIn(DOC_TYPE_INPUTS, {
    message: 'El tipo de documento por defecto no es válido.',
  })
  defaultDocType?: DocTypeInput;
}

/** Campos de la subida de la hoja de saldos (DX-262, QA D1). */
export class UploadBalancesDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description:
      '«Añadir aunque ya tenga saldo migrado»: con true, un paciente que ya tiene un saldo migrado vivo en esa moneda de otro lote recibe otro (aviso EXISTING_BALANCE). Sin él, esa fila es un error y no se crea.',
  })
  @IsOptional()
  @IsIn(['true', 'false'], {
    message: '«Añadir aunque ya tenga saldo migrado» debe ser true o false.',
  })
  addToExisting?: 'true' | 'false';
}

export class ConfirmPatientImportDto {
  @ApiProperty({
    enum: PatientImportDuplicateMode,
    enumName: 'PatientImportDuplicateMode',
    description:
      'SKIP: no tocar a los pacientes que ya existen · FILL_EMPTY: rellenar solo sus campos vacíos (nunca pisa un dato)',
  })
  @IsEnum(PatientImportDuplicateMode, {
    message:
      'Elige qué hacer con los pacientes que ya existen: SKIP o FILL_EMPTY.',
  })
  duplicateMode!: PatientImportDuplicateMode;
}

export class ListPatientImportsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class ImportFieldDescriptorDto {
  @ApiProperty({ example: 'firstName' })
  key!: string;
  @ApiProperty({ example: 'Nombres' })
  label!: string;
  @ApiProperty()
  required!: boolean;
  @ApiProperty({ example: 'nombres', description: 'Cabecera en la plantilla' })
  header!: string;
}

export class ColumnMappingDto {
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() docNumber?: string;
  @ApiPropertyOptional() firstName?: string;
  @ApiPropertyOptional() lastName?: string;
  @ApiPropertyOptional() birthDate?: string;
  @ApiPropertyOptional() sex?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() address?: string;
  @ApiPropertyOptional() occupation?: string;
  @ApiPropertyOptional() emergencyContactName?: string;
  @ApiPropertyOptional() emergencyContactPhone?: string;
  @ApiPropertyOptional() notes?: string;
}

export class PatientImportInspectDto {
  @ApiProperty() fileName!: string;
  @ApiProperty({
    enum: PatientImportFileFormat,
    enumName: 'PatientImportFileFormat',
  })
  fileFormat!: PatientImportFileFormat;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'utf-8',
    description: 'Solo CSV: utf-8, windows-1252 o utf-16le',
  })
  encoding!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: ';',
    description: 'Solo CSV',
  })
  delimiter!: string | null;
  @ApiProperty({ type: [String] })
  headers!: string[];
  @ApiProperty({ type: ColumnMappingDto })
  suggestedMapping!: ColumnMappingDto;
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    description: 'Primeras filas tal cual, para reconocer las columnas',
  })
  sampleRows!: string[][];
  @ApiProperty({ description: 'Filas con datos (sin la cabecera)' })
  totalRows!: number;
  @ApiProperty({ type: [ImportFieldDescriptorDto] })
  fields!: ImportFieldDescriptorDto[];
}

export class ImportUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) fullName!: string | null;
}

export class ImportMappingDto {
  @ApiProperty({ type: ColumnMappingDto }) columns!: ColumnMappingDto;
  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType', nullable: true })
  defaultDocType!: DocumentType | null;
}

export class ImportTotalsDto {
  @ApiProperty({ description: 'Filas con datos del archivo' })
  totalRows!: number;
  @ApiProperty({ description: 'Pacientes nuevos que se crearán' })
  validRows!: number;
  @ApiProperty({
    description: 'Ya existen en la clínica o se repiten en el archivo',
  })
  duplicateRows!: number;
  @ApiProperty({ description: 'Filas con algún error: no se importan' })
  errorRows!: number;
}

export class ImportProgressDto {
  @ApiProperty({
    description: 'Filas que procesa el trabajo (nuevas + ya existentes)',
  })
  preparedRows!: number;
  @ApiProperty() processedRows!: number;
  @ApiProperty() createdCount!: number;
  @ApiProperty({ description: 'Existentes con campos vacíos rellenados' })
  updatedCount!: number;
  @ApiProperty() skippedCount!: number;
  @ApiProperty() failedCount!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) percent!: number;
}

export class ImportIssueDto {
  @ApiProperty({ description: 'Fila del archivo (1 = cabecera)' }) row!: number;
  @ApiProperty({ nullable: true, type: String }) column!: string | null;
  @ApiProperty({
    enum: [
      'ERROR',
      'DUPLICATE_FILE',
      'DUPLICATE_EXISTING',
      'MERGED',
      'EXISTING_BALANCE',
    ],
    enumName: 'PatientImportIssueKind',
    description:
      'MERGED (DX-262): fila de la hoja de saldos sumada a otra del mismo paciente y moneda (aviso, no error). EXISTING_BALANCE (QA D1): el paciente ya tenía un saldo migrado vivo en esa moneda y se añade otro porque se marcó «Añadir aunque ya tenga saldo migrado» (aviso, no error).',
  })
  kind!:
    | 'ERROR'
    | 'DUPLICATE_FILE'
    | 'DUPLICATE_EXISTING'
    | 'MERGED'
    | 'EXISTING_BALANCE';
  @ApiProperty({ description: 'Motivo en español' }) message!: string;
  @ApiProperty({ nullable: true, type: String }) value!: string | null;
}

export class ImportPatientDataDto {
  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType' })
  docType!: DocumentType;
  @ApiProperty() docNumber!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional({ format: 'date' }) birthDate?: string;
  @ApiPropertyOptional({ enum: ['M', 'F', 'OTHER'] }) sex?: 'M' | 'F' | 'OTHER';
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() address?: string;
  @ApiPropertyOptional() occupation?: string;
  @ApiPropertyOptional() emergencyContactName?: string;
  @ApiPropertyOptional() emergencyContactPhone?: string;
  @ApiPropertyOptional() notes?: string;
}

export class ImportPreviewRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ enum: ['NEW', 'EXISTING'] }) status!: 'NEW' | 'EXISTING';
  @ApiProperty({ type: ImportPatientDataDto }) data!: ImportPatientDataDto;
}

export class BalanceCurrencyTotalDto {
  @ApiProperty({ example: 'COP' }) currency!: string;
  @ApiProperty({ description: 'Filas del archivo' }) rows!: number;
  @ApiProperty({ example: 1500000.5 }) amount!: number;
}

export class ImportedBalanceTotalDto {
  @ApiProperty({ example: 'COP' }) currency!: string;
  @ApiProperty({ description: 'Saldos migrados vivos' }) count!: number;
  @ApiProperty({ example: 1500000.5 }) amount!: number;
}

export class BalanceProgressDto {
  @ApiProperty() processed!: number;
  @ApiProperty() created!: number;
  @ApiProperty({
    description: 'No creados: su paciente no existía al importar',
  })
  skipped!: number;
  @ApiProperty({
    description:
      'No creados: su documento era de varios pacientes vivos (ambiguo)',
  })
  ambiguous!: number;
  @ApiProperty({
    description:
      'No creados: el paciente ya tenía un saldo migrado vivo en esa moneda de otro lote (QA D1)',
  })
  existing!: number;
}

/** Hoja de saldos «Saldo migrado» del lote (DX-262). */
export class PatientImportBalancesDto {
  @ApiProperty() fileName!: string;
  @ApiProperty({
    enum: PatientImportFileFormat,
    enumName: 'PatientImportFileFormat',
  })
  fileFormat!: PatientImportFileFormat;
  @ApiProperty() fileSizeBytes!: number;
  @ApiProperty({ description: 'SHA-256 (hex) de la hoja de saldos' })
  fileSha256!: string;
  @ApiProperty({ description: 'Filas con datos' }) totalRows!: number;
  @ApiProperty({
    description: 'Filas que se importan (las sumadas a otra incluidas)',
  })
  validRows!: number;
  @ApiProperty({ description: 'Filas con algún error: no se importan' })
  errorRows!: number;
  @ApiProperty({
    description: 'Filas sumadas a otra del mismo paciente y moneda',
  })
  mergedRows!: number;
  @ApiProperty({ description: 'Saldos a crear: uno por paciente y moneda' })
  preparedCount!: number;
  @ApiProperty({
    description:
      '«Añadir aunque ya tenga saldo migrado» marcado al subir la hoja (QA D1)',
  })
  addToExisting!: boolean;
  @ApiProperty({
    type: [BalanceCurrencyTotalDto],
    description:
      'Total del archivo por moneda (filas con importe y moneda legibles)',
  })
  fileTotals!: BalanceCurrencyTotalDto[];
  @ApiProperty({
    type: [BalanceCurrencyTotalDto],
    description: 'Lo que se importa, por moneda (sin convertir)',
  })
  validTotals!: BalanceCurrencyTotalDto[];
  @ApiProperty({
    type: [ImportedBalanceTotalDto],
    description: 'Saldos migrados vivos del lote, por moneda',
  })
  imported!: ImportedBalanceTotalDto[];
  @ApiProperty({ type: BalanceProgressDto }) progress!: BalanceProgressDto;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Saldos que retiró el deshacer',
  })
  undoneCount!: number | null;
  @ApiProperty({
    type: [BalanceCurrencyTotalDto],
    description: 'Lo que retiró de verdad el deshacer, por moneda',
  })
  undoneTotals!: BalanceCurrencyTotalDto[];
  @ApiProperty({
    description:
      'Lote terminado con saldos vivos: se pueden retirar solos (POST :id/balances/undo)',
  })
  canUndo!: boolean;
}

export class PatientImportBatchDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PatientImportStatus, enumName: 'PatientImportStatus' })
  status!: PatientImportStatus;
  @ApiProperty() fileName!: string;
  @ApiProperty({
    enum: PatientImportFileFormat,
    enumName: 'PatientImportFileFormat',
  })
  fileFormat!: PatientImportFileFormat;
  @ApiProperty() fileSizeBytes!: number;
  @ApiProperty({ description: 'SHA-256 (hex) del archivo subido' })
  fileSha256!: string;
  @ApiProperty({ format: 'uuid', description: 'Sede por defecto del lote' })
  locationId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: ImportUserDto }) createdBy!: ImportUserDto;
  @ApiProperty({ type: ImportMappingDto }) columnMapping!: ImportMappingDto;
  @ApiProperty({ type: ImportTotalsDto }) totals!: ImportTotalsDto;
  @ApiProperty({ type: ImportProgressDto }) progress!: ImportProgressDto;
  @ApiProperty({
    enum: PatientImportDuplicateMode,
    enumName: 'PatientImportDuplicateMode',
    nullable: true,
  })
  duplicateMode!: PatientImportDuplicateMode | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  undoneAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) undoneCreated!: number | null;
  @ApiProperty({ type: Number, nullable: true }) undoneFilled!: number | null;
  @ApiProperty({ description: 'Validado, con filas y sin caducar' })
  canConfirm!: boolean;
  @ApiProperty({
    description: 'Terminado o fallido: se puede intentar deshacer',
  })
  canUndo!: boolean;
  @ApiProperty({
    description:
      'El informe de errores (errors.csv) sigue disponible: ni caducado ni purgado a los 90 días',
  })
  reportAvailable!: boolean;
  @ApiProperty({
    type: PatientImportBalancesDto,
    nullable: true,
    description: 'DX-262: hoja de saldos del lote; null si no trae',
  })
  balances!: PatientImportBalancesDto | null;
}

export class PatientImportBatchDetailDto extends PatientImportBatchDto {
  @ApiProperty({
    type: [ImportIssueDto],
    description: 'Los primeros 200; todos en errors.csv',
  })
  issues!: ImportIssueDto[];
  @ApiProperty() issuesTotal!: number;
  @ApiProperty({
    type: [ImportPreviewRowDto],
    description: 'Solo en el dry-run: las primeras filas que se importarán',
  })
  preview!: ImportPreviewRowDto[];
  @ApiProperty({
    type: [ImportIssueDto],
    description:
      'DX-262: errores y avisos de la hoja de saldos (los primeros 200; todos en balances/errors.csv)',
  })
  balanceIssues!: ImportIssueDto[];
  @ApiProperty() balanceIssuesTotal!: number;
}

export class PatientImportListDto {
  @ApiProperty({ type: [PatientImportBatchDto] })
  items!: PatientImportBatchDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
