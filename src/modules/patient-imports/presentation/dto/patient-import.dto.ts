import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DocType,
  PatientImportDuplicateMode,
  PatientImportFileFormat,
  PatientImportStatus,
} from '@prisma/client';
import { IMPORT_FIELD_KEYS } from '../../domain/import-fields';

const FIELD_KEYS_DOC = IMPORT_FIELD_KEYS.join(', ');

/**
 * Campos de texto del multipart del dry-run (el fichero va en `file`).
 * `mapping` es un JSON `{ campo: cabecera }`; lo valida el controlador con
 * mensajes en español.
 */
export class CreatePatientImportDto {
  @ApiPropertyOptional({
    description: `JSON con el mapeo campo de Dentalix → cabecera del archivo, p. ej. {"firstName":"Nombre","docNumber":"Cédula"}. Campos: ${FIELD_KEYS_DOC}. Sin él, el mapeo sugerido.`,
    example:
      '{"firstName":"Nombres","lastName":"Apellidos","docNumber":"Cédula"}',
  })
  @IsOptional()
  @IsString({ message: 'El mapeo de columnas debe ser un JSON.' })
  @MaxLength(4000, { message: 'El mapeo de columnas es demasiado largo.' })
  mapping?: string;

  @ApiPropertyOptional({
    enum: DocType,
    enumName: 'DocType',
    description:
      'Tipo de documento cuando la columna no está o la celda va vacía',
  })
  @IsOptional()
  @IsEnum(DocType, {
    message: 'El tipo de documento por defecto no es válido.',
  })
  defaultDocType?: DocType;
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
  @ApiProperty({ enum: DocType, enumName: 'DocType', nullable: true })
  defaultDocType!: DocType | null;
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
    enum: ['ERROR', 'DUPLICATE_FILE', 'DUPLICATE_EXISTING'],
    enumName: 'PatientImportIssueKind',
  })
  kind!: 'ERROR' | 'DUPLICATE_FILE' | 'DUPLICATE_EXISTING';
  @ApiProperty({ description: 'Motivo en español' }) message!: string;
  @ApiProperty({ nullable: true, type: String }) value!: string | null;
}

export class ImportPatientDataDto {
  @ApiProperty({ enum: DocType, enumName: 'DocType' }) docType!: DocType;
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
}

export class PatientImportListDto {
  @ApiProperty({ type: [PatientImportBatchDto] })
  items!: PatientImportBatchDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
