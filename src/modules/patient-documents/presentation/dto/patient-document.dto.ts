import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PatientDocumentCategory } from '@prisma/client';

const CATEGORY_DOC =
  'XRAY radiografía · PHOTO foto clínica · REFERRAL remisión · SIGNED_CONSENT consentimiento firmado (escaneado) · REPORT informe · OTHER otro';

/**
 * Campos de texto del multipart (el fichero va en `file`). Sin tenant,
 * paciente, autor, sede, tipo ni hora: los pone el servidor (el tipo lo
 * decide el CONTENIDO). Opcionales en la forma A PROPÓSITO: los valida el
 * dominio con su mensaje en español (`document-rules.ts`).
 */
export class UploadPatientDocumentDto {
  @ApiProperty({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
    description: CATEGORY_DOC,
  })
  @IsOptional()
  @IsString({ message: 'La categoría no es válida.' })
  category?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-17',
    description: 'Día clínico del documento (no futuro en la sede)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha clínica no es válida.' })
  clinicalDate?: string;

  @ApiPropertyOptional({
    example: '11,21',
    description: 'Dientes FDI separados por comas (como mucho 8)',
  })
  @IsOptional()
  @IsString({ message: 'Los dientes deben ir separados por comas.' })
  toothNumbers?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto.' })
  notes?: string;
}

export class ListPatientDocumentsQueryDto {
  @ApiPropertyOptional({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
  })
  @IsOptional()
  @IsString({ message: 'Filtra por una sola categoría.' })
  category?: string;

  @ApiPropertyOptional({ example: '11', description: 'Diente FDI' })
  @IsOptional()
  @IsString({ message: 'Filtra por un solo diente.' })
  tooth?: string;
}

export class VoidPatientDocumentDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'El motivo debe ser un texto.' })
  reason?: string;
}

export class PatientDocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid', description: 'Sede activa al subirlo' })
  locationId!: string;
  @ApiProperty({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
  })
  category!: PatientDocumentCategory;
  @ApiProperty({ description: 'Nombre original (solo para mostrar)' })
  originalName!: string;
  @ApiProperty({ description: 'Tipo DETECTADO por el contenido' })
  mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ description: 'SHA-256 del contenido (hex)' }) sha256!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  clinicalDate!: string | null;
  @ApiProperty({ type: [String] }) toothNumbers!: string[];
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ format: 'uuid' }) uploadedById!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedByName!: string | null;
  @ApiProperty() uploadedAt!: Date;
  @ApiProperty({
    description: 'PDF, JPEG o PNG: se puede abrir en el navegador',
  })
  inlineViewable!: boolean;
  @ApiProperty({ type: Date, nullable: true }) voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voidedById!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
}

export class PatientDocumentUrlDto {
  @ApiProperty({ description: 'URL firmada de corta vida' }) url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['inline', 'attachment'] })
  disposition!: 'inline' | 'attachment';
}

/**
 * DX-259: lo que declara el navegador para pedir la subida directa al
 * almacén. El tipo lo decide igualmente el contenido al completar.
 */
export class CreatePatientDocumentUploadDto {
  @ApiPropertyOptional({
    example: 'radiografia-11.pdf',
    description: 'Nombre del fichero (solo para mostrar; no se guarda aquí)',
  })
  @IsOptional()
  @IsString({ message: 'El nombre del archivo debe ser un texto.' })
  @MaxLength(1024, { message: 'El nombre del archivo es demasiado largo.' })
  fileName?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString({ message: 'El tipo del archivo debe ser un texto.' })
  @MaxLength(255, { message: 'El tipo del archivo es demasiado largo.' })
  mimeType?: string;

  @ApiProperty({
    minimum: 1,
    maximum: 20 * 1024 * 1024,
    description: 'Tamaño en bytes (1 B – 20 MB)',
  })
  @IsInt({ message: 'El tamaño del archivo no es válido.' })
  sizeBytes!: number;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'SHA-256 del contenido en hex. El almacén rechaza un contenido con otra huella.',
  })
  @IsString({ message: 'La huella SHA-256 del archivo no es válida.' })
  sha256!: string;
}

export class PatientDocumentUploadDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Id del documento: el de `POST …/:documentId/complete`',
  })
  documentId!: string;

  @ApiProperty({ enum: ['POST'] }) method!: 'POST';

  @ApiProperty({
    description:
      'Adónde se envía el formulario: el bucket (S3) o la API (disco, en desarrollo)',
  })
  url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Campos del formulario, en este orden y ANTES del fichero, que va al final en el campo `file`',
  })
  fields!: Record<string, string>;

  @ApiProperty({ format: 'date-time' }) expiresAt!: string;

  @ApiProperty({ description: 'Tamaño máximo en bytes' }) maxBytes!: number;
}

/**
 * DX-259: campos del formulario al terminar la subida directa (los mismos que
 * el multipart, con los dientes en una lista) y lo que declara el navegador
 * del fichero.
 */
export class CompletePatientDocumentUploadDto {
  @ApiProperty({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
    description: CATEGORY_DOC,
  })
  @IsOptional()
  @IsString({ message: 'La categoría no es válida.' })
  category?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-17',
    description: 'Día clínico del documento (no futuro en la sede)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha clínica no es válida.' })
  clinicalDate?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['11', '21'],
    description: 'Dientes FDI (como mucho 8)',
  })
  @IsOptional()
  @IsArray({ message: 'Los dientes deben ir en una lista.' })
  @IsString({ each: true, message: 'Cada diente debe ser un texto.' })
  toothNumbers?: string[];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto.' })
  notes?: string;

  @ApiPropertyOptional({ description: 'Nombre original (solo para mostrar)' })
  @IsOptional()
  @IsString({ message: 'El nombre del archivo debe ser un texto.' })
  @MaxLength(1024, { message: 'El nombre del archivo es demasiado largo.' })
  fileName?: string;

  @ApiPropertyOptional({
    description: 'Tipo que declara el navegador; debe cuadrar con el contenido',
  })
  @IsOptional()
  @IsString({ message: 'El tipo del archivo debe ser un texto.' })
  @MaxLength(255, { message: 'El tipo del archivo es demasiado largo.' })
  mimeType?: string;
}
